"""Stateful local-model investigator for full PD -> RD/ID comparison."""
from __future__ import annotations

import json
import math
import os
import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Sequence

from .conversation_llm import append_turn, call_conversation_json
from .inspector_memory import blind_mode, lessons_prompt
from .llm import LlmConfig, call_llm_json
from .matching import DocumentInput
from .requirement_registry import Requirement
from .semantic_contract import OBSERVED_CONTRADICTION, WRONG_OR_INSUFFICIENT_SCOPE, normalize_bbox, normalize_difference_kind
from .vision import UNTRUSTED_INPUT_RULE, render_page_to_data_url


def _int_env(name: str, default: int, lo: int, hi: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(lo, min(hi, value))


MAX_TURNS_CAP = _int_env("INSPECTOR_INVESTIGATOR_MAX_TURNS", 64, 16, 96)
MIN_TURNS = _int_env("INSPECTOR_INVESTIGATOR_MIN_TURNS", 24, 12, 48)
MAX_PAGES = _int_env("INSPECTOR_INVESTIGATOR_PAGES_PER_ACTION", 4, 1, 6)
MAX_TEXT_PAGES = _int_env("INSPECTOR_INVESTIGATOR_TEXT_PAGES_PER_ACTION", 6, 1, 10)
MAX_REGIONS = _int_env("INSPECTOR_INVESTIGATOR_REGIONS_PER_ACTION", 3, 1, 4)
MAX_VERIFY_REFS = _int_env("INSPECTOR_INVESTIGATOR_VERIFY_REFS", 3, 1, 4)
PAGE_HINT_CHARS = _int_env("INSPECTOR_INVESTIGATOR_PAGE_HINT_CHARS", 220, 80, 600)
SEARCH_TEXT_CHARS = _int_env("INSPECTOR_INVESTIGATOR_SEARCH_TEXT_CHARS", 12000, 1500, 24000)
PAGE_TEXT_CHARS = _int_env("INSPECTOR_INVESTIGATOR_PAGE_TEXT_CHARS", 8000, 1000, 16000)

INVESTIGATOR_SYSTEM = f"""Ты — ведущий AI-инспектор строительной документации.
Исследуй ПД и РД/ИД и ищи инженерно значимые изменения. У тебя есть память
расследования и инструменты. Python routing/search — только навигация.

{UNTRUSTED_INPUT_RULE}

Правила:
- «не вижу на evidence» != «объект отсутствует»;
- схема/план/спецификация могут описывать одно решение по-разному;
- multi-room requirement проверяй по каждой цели отдельно;
- whole-page observation — гипотеза; локальное изменение перепроверяй zoom;
- если verifier вернул needs_more, добери именно недостающий evidence;
- не заканчивай при непросмотренных high-value requirements/листах/легендах;
- цена пропуска выше цены дополнительного хода.

В каждом ответе ровно один action и только JSON:
{{"action":"search","query":"...","reason":"..."}}
{{"action":"read_text","refs":["PD0:P1","RD0:P3"],"reason":"..."}}
{{"action":"inspect_pages","refs":["PD0:P1","RD0:P3"],"reason":"..."}}
{{"action":"zoom","regions":[{{"ref":"RD0:P3","bbox":[0.1,0.2,0.4,0.5],"reason":"..."}}],"reason":"..."}}
{{"action":"propose_finding","finding":{{
"title":"...","difference":"...","difference_kind":"presence_absence|configuration|connection|parameter|topology|quantity|location|coverage|other",
"pd_refs":["PD0:P1"],"rd_refs":["RD0:P3"],"pd_observation":"...","rd_observation":"...",
"pd_bbox":[0.1,0.2,0.4,0.5],"rd_bbox":[0.2,0.2,0.5,0.5],"requirement_ids":["R1"],"why_it_matters":"..."}}}}
{{"action":"finish","summary":"...","requirements_checked":["R1"],"unresolved":[]}}
"""

VERIFY_SYSTEM = f"""Ты — независимый verifier кандидата ПД↔РД/ИД.
Не доверяй investigator; смотри только на evidence.
{UNTRUSTED_INPUT_RULE}
Нужны конкретные наблюдения ПД и РД и прямое отличие.
NOT_OBSERVED никогда не повышай до ABSENCE.
Presence/absence подтверждай только при достаточном обязательном scope.
Если scope/подписи/границы недостаточны — needs_more.
Ответ только JSON:
{{"verdict":"confirmed|needs_more|rejected",
"state":"OBSERVED_CONTRADICTION|NOT_OBSERVED_ON_THIS_EVIDENCE|WRONG_OR_INSUFFICIENT_SCOPE",
"pd_observation":"...","rd_observation":"...","difference":"...",
"difference_kind":"presence_absence|configuration|connection|parameter|topology|quantity|location|coverage|other",
"scope_sufficient":false,"absence_scope_complete":false,
"missing_evidence":["..."],"reason":"..."}}"""


@dataclass
class InvestigatorResult:
    findings: list[dict] = field(default_factory=list)
    candidates: list[dict] = field(default_factory=list)
    diagnostics: dict = field(default_factory=dict)


def _page_text(document: DocumentInput, page: int) -> str:
    return "\n".join(str(x.get("text") or "") for x in document.text_facts if int(x.get("page") or 0) == page).strip()


def _labels(items: Sequence[dict], page: int, limit: int = 30) -> list[str]:
    out: list[str] = []
    for item in items:
        if int(item.get("page") or 0) != page:
            continue
        key = str(item.get("key") or "").strip()
        name = str(item.get("name") or "").strip()
        label = (key if not name else f"{key} {name}").strip()
        if label and label not in out:
            out.append(label)
    return out[:limit]


def build_page_catalog(before_docs: Sequence[DocumentInput], after_docs: Sequence[DocumentInput]) -> list[dict]:
    rows: list[dict] = []
    for side, docs in (("PD", before_docs), ("RD", after_docs)):
        for di, document in enumerate(docs):
            for page in range(1, int(document.pages) + 1):
                text = " ".join(_page_text(document, page).split())
                rows.append({
                    "ref": f"{side}{di}:P{page}", "side": side, "document": document.name, "page": page,
                    "page_kind": document.page_kinds.get(page, "unknown"), "discipline": document.discipline_code or "",
                    "rooms": _labels(document.room_facts, page), "equipment": _labels(document.equipment_facts, page),
                    "text_hint": text[:PAGE_HINT_CHARS], "search_text": text[:SEARCH_TEXT_CHARS],
                })
    return rows


def _ref_map(before_docs, after_docs, before_paths, after_paths) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for side, docs, paths in (("PD", before_docs, before_paths), ("RD", after_docs, after_paths)):
        if len(docs) != len(paths):
            raise ValueError(f"{side}: для каждого документа нужен соответствующий источник")
        for di, document in enumerate(docs):
            for page in range(1, int(document.pages) + 1):
                out[f"{side}{di}:P{page}"] = {"document": document, "path": str(paths[di]), "page": page}
    return out


_TOKEN_RE = re.compile(r"[0-9A-Za-zА-Яа-яЁё._/-]{2,}")


def _public_row(row: dict) -> dict:
    return {k: v for k, v in row.items() if k != "search_text"}


def _search(catalog: list[dict], query: str, limit: int = 12) -> list[dict]:
    terms = {x.casefold() for x in _TOKEN_RE.findall(query)}
    scored = []
    for row in catalog:
        hay = " ".join([
            str(row.get("document") or ""), str(row.get("page_kind") or ""), str(row.get("discipline") or ""),
            " ".join(row.get("rooms") or []), " ".join(row.get("equipment") or []), str(row.get("search_text") or ""),
        ]).casefold()
        score = sum(3 for t in terms if t in hay)
        if score:
            scored.append((score, row))
    scored.sort(key=lambda x: (-x[0], x[1]["ref"]))
    rows = [r for _, r in scored[:limit]] if terms else catalog[:limit]
    return [_public_row(r) for r in rows]


def _requirements_payload(requirements: Sequence[Requirement]) -> list[dict]:
    out = []
    for i, req in enumerate(requirements, 1):
        out.append({
            "id": f"R{i}", "document": req.document, "page": req.page,
            "rooms": list(req.rooms or req.rooms_by_name or []), "summary": req.summary or req.sentence,
            "source_text": (req.sentence or req.summary or "")[:900],
        })
    return out


def _normalize_refs(value, ref_map, limit) -> list[str]:
    out = []
    for raw in value if isinstance(value, list) else []:
        ref = str(raw or "").strip().upper()
        if ref in ref_map and ref not in out:
            out.append(ref)
        if len(out) >= limit:
            break
    return out


def _normalize_candidate(value, ref_map) -> dict | None:
    if not isinstance(value, dict):
        return None
    pd_refs = [r for r in _normalize_refs(value.get("pd_refs"), ref_map, 6) if r.startswith("PD")]
    rd_refs = [r for r in _normalize_refs(value.get("rd_refs"), ref_map, 6) if r.startswith("RD")]
    diff = " ".join(str(value.get("difference") or "").split())
    pdo = " ".join(str(value.get("pd_observation") or "").split())
    rdo = " ".join(str(value.get("rd_observation") or "").split())
    if not pd_refs or not rd_refs or not diff or not pdo or not rdo:
        return None
    req_ids = []
    for raw in value.get("requirement_ids") or []:
        rid = str(raw or "").strip().upper()
        if re.fullmatch(r"R\d+", rid) and rid not in req_ids:
            req_ids.append(rid)
    return {
        "title": " ".join(str(value.get("title") or "").split())[:240], "difference": diff[:1600],
        "difference_kind": normalize_difference_kind(value.get("difference_kind")), "pd_refs": pd_refs, "rd_refs": rd_refs,
        "pd_observation": pdo[:1600], "rd_observation": rdo[:1600], "pd_bbox": normalize_bbox(value.get("pd_bbox")),
        "rd_bbox": normalize_bbox(value.get("rd_bbox")), "requirement_ids": req_ids,
        "why_it_matters": " ".join(str(value.get("why_it_matters") or "").split())[:1200],
    }


def _compact_catalog(catalog: list[dict]) -> str:
    return json.dumps([_public_row(r) for r in catalog], ensure_ascii=False, separators=(",", ":"))


def _tool_text(refs: list[str], ref_map: dict[str, dict]) -> str:
    rows = []
    for ref in refs:
        item = ref_map[ref]
        rows.append(f"[{ref}]\n<НЕДОВЕРЕННЫЙ_ДОКУМЕНТ>{_page_text(item['document'], int(item['page']))[:PAGE_TEXT_CHARS]}</НЕДОВЕРЕННЫЙ_ДОКУМЕНТ>")
    return "TOOL RESULT: text layers\n" + "\n\n".join(rows)


def _render(item: dict, bbox=None) -> str:
    return render_page_to_data_url(item["path"], int(item["page"]), clip_frac=bbox) if bbox is not None else render_page_to_data_url(item["path"], int(item["page"]))


def _tool_pages(refs, ref_map):
    lines, images, rendered, failures = ["TOOL RESULT: opened pages"], [], [], []
    for ref in refs:
        item = ref_map[ref]
        try:
            images.append(_render(item)); rendered.append(ref)
            text = _page_text(item["document"], int(item["page"]))[:PAGE_TEXT_CHARS]
            lines.append(f"[{ref}]\nTEXT:\n<НЕДОВЕРЕННЫЙ_ДОКУМЕНТ>{text}</НЕДОВЕРЕННЫЙ_ДОКУМЕНТ>")
        except Exception as exc:
            failures.append(f"{ref}: {type(exc).__name__}: {exc}")
            lines.append(f"[{ref}] RENDER FAILURE — uncertainty, not absence")
    return "\n".join(lines), images, rendered, failures


def _tool_zoom(regions, ref_map):
    lines, images, accepted, failures = ["TOOL RESULT: zoomed regions"], [], [], []
    for raw in regions[:MAX_REGIONS]:
        if not isinstance(raw, dict):
            continue
        ref = str(raw.get("ref") or "").strip().upper(); box = normalize_bbox(raw.get("bbox"))
        if ref not in ref_map or box is None:
            continue
        area = max(0.0, box[2]-box[0]) * max(0.0, box[3]-box[1])
        if area < 0.005 or area > 0.65:
            continue
        try:
            item = ref_map[ref]; images.extend([_render(item), _render(item, box)])
            accepted.append({"ref": ref, "bbox": box, "reason": str(raw.get("reason") or "")[:500]})
            lines.append(f"{ref} bbox={box}")
        except Exception as exc:
            failures.append(f"{ref}: {type(exc).__name__}: {exc}")
    return "\n".join(lines), images, accepted, failures


def _verification_images(candidate, ref_map):
    images, refs = [], []
    for side_key, bbox_key in (("pd_refs", "pd_bbox"), ("rd_refs", "rd_bbox")):
        side_refs = candidate.get(side_key) or []; bbox = candidate.get(bbox_key)
        for ref in side_refs[:MAX_VERIFY_REFS]:
            item = ref_map.get(ref)
            if not item:
                continue
            images.append(_render(item)); refs.append(ref)
            if bbox is not None and len(side_refs) == 1:
                images.append(_render(item, bbox))
    return images[:12], refs


def _verify_candidate(config, candidate, ref_map, req_by_id):
    try:
        images, evidence_refs = _verification_images(candidate, ref_map)
        related = [req_by_id[r] for r in candidate.get("requirement_ids") or [] if r in req_by_id]
        prompt = "CANDIDATE:\n" + json.dumps(candidate, ensure_ascii=False) + "\nRELATED REQUIREMENTS:\n" + json.dumps(related, ensure_ascii=False) + "\nEVIDENCE REFS: " + ", ".join(evidence_refs)
        result = call_llm_json(config, VERIFY_SYSTEM, prompt, images=images, operation="vision",
            source_digest="stateful-verifier-v2:" + "|".join(evidence_refs), prompt_version="stateful-investigator-verifier-v2", use_cache=False)
        return result if isinstance(result, dict) else {}
    except Exception as exc:
        return {"verdict": "needs_more", "state": WRONG_OR_INSUFFICIENT_SCOPE,
                "reason": f"verifier technical failure: {type(exc).__name__}: {exc}", "error": True}


def _confirmed(candidate, verification) -> bool:
    if str(verification.get("verdict") or "").casefold() != "confirmed": return False
    if str(verification.get("state") or "").upper() != OBSERVED_CONTRADICTION: return False
    if not bool(verification.get("scope_sufficient")): return False
    if not all(str(verification.get(k) or "").strip() for k in ("pd_observation", "rd_observation", "difference")): return False
    kind = normalize_difference_kind(verification.get("difference_kind") or candidate.get("difference_kind"))
    return kind != "presence_absence" or bool(verification.get("absence_scope_complete"))


def _candidate_key(candidate) -> tuple:
    return (tuple(candidate.get("pd_refs") or []), tuple(candidate.get("rd_refs") or []), str(candidate.get("difference") or "").casefold())


def _topic_key(candidate) -> tuple:
    return (tuple(candidate.get("requirement_ids") or []), normalize_difference_kind(candidate.get("difference_kind")), tuple(candidate.get("pd_refs") or []))


def _finding_from(candidate, verification) -> dict:
    return {
        "source": "stateful_investigator", "domain": "semantic", "key": "|".join((candidate.get("pd_refs") or []) + (candidate.get("rd_refs") or [])),
        "detail": str(verification.get("difference") or candidate["difference"]), "state": OBSERVED_CONTRADICTION,
        "difference_kind": normalize_difference_kind(verification.get("difference_kind") or candidate.get("difference_kind")),
        "pd_observation": str(verification.get("pd_observation") or candidate["pd_observation"]),
        "rd_observation": str(verification.get("rd_observation") or candidate["rd_observation"]),
        "pd_refs": list(candidate.get("pd_refs") or []), "rd_refs": list(candidate.get("rd_refs") or []),
        "pd_bbox": candidate.get("pd_bbox"), "rd_bbox": candidate.get("rd_bbox"), "requirement_ids": list(candidate.get("requirement_ids") or []),
        "verified": True, "verification_reason": str(verification.get("reason") or ""),
    }


def _effective_turn_budget(pages_total: int, requirements_total: int) -> int:
    scaled = MIN_TURNS + math.ceil(pages_total / 8) + math.ceil(requirements_total / 4)
    return min(MAX_TURNS_CAP, max(MIN_TURNS, scaled))


def _room_token(label: str) -> str:
    m = re.search(r"\b(\d{1,6})\b", str(label or ""))
    return m.group(1) if m else str(label or "").strip()


def _requirement_target_coverage(req_payload, catalog, visual_refs, search_queries) -> dict:
    searched = " ".join(search_queries).casefold(); rows, blockers = [], []
    for req in req_payload:
        for raw_target in req.get("rooms") or []:
            target = _room_token(raw_target)
            rd_refs = [r["ref"] for r in catalog if r.get("side") == "RD" and any(_room_token(x) == target for x in r.get("rooms") or [])]
            if any(ref in visual_refs for ref in rd_refs): status = "visited"
            elif rd_refs: status = "available_uninspected"
            elif target and target.casefold() in searched: status = "unlocated_after_search"
            else: status = "unsearched_unlocated"
            row = {"requirement_id": req["id"], "target": target, "rd_refs": rd_refs[:12], "status": status}; rows.append(row)
            if status in {"available_uninspected", "unsearched_unlocated"}: blockers.append(row)
    return {"targets_total": len(rows), "targets_visited": sum(r["status"] == "visited" for r in rows),
            "targets_blocking_finish": len(blockers), "rows": rows, "blockers": blockers}


def _history_user_text(text: str, first_turn: bool) -> str:
    return text if first_turn or len(text) <= 9000 else text[:8500] + "\n[tool payload compacted]"


def _state_note(visual_refs, text_refs, search_queries, findings, unresolved, coverage, remaining_turns) -> str:
    return ("\nSESSION NOTE:" f" visual_refs={sorted(visual_refs)};" f" text_refs={sorted(text_refs)};"
            f" searches={len(search_queries)};" f" confirmed={len(findings)};" f" unresolved={len(unresolved)};"
            f" coverage_blockers={coverage.get('targets_blocking_finish',0)};" f" turns_remaining={remaining_turns}.")


def run_stateful_investigator(before_docs: Sequence[DocumentInput], after_docs: Sequence[DocumentInput],
                              before_paths: Sequence[str], after_paths: Sequence[str],
                              requirements: Sequence[Requirement], config: LlmConfig) -> InvestigatorResult:
    catalog = build_page_catalog(before_docs, after_docs); refs = _ref_map(before_docs, after_docs, before_paths, after_paths)
    req_payload = _requirements_payload(requirements); req_by_id = {r["id"]: r for r in req_payload}
    max_turns = _effective_turn_budget(len(catalog), len(requirements))
    initial = ("DOCUMENT MAP (navigation only):\n" + _compact_catalog(catalog) + "\nPD REQUIREMENTS:\n"
               + json.dumps(req_payload, ensure_ascii=False, separators=(",", ":")) + "\n" + lessons_prompt()
               + "\nStart investigation. Use search/read_text before vision when useful.")
    history, findings, verification_rows = [], [], []
    pending_by_topic: dict[tuple, dict] = {}; confirmed_topics, seen_candidate_keys = set(), set()
    action_counts: Counter[str] = Counter(); visual_refs, text_refs, search_queries, zoomed = set(), set(), [], []
    tool_failures, errors, transcript = [], [], []; user_text, current_images = initial, []
    finish_requested = self_reviewed = finished = False; finish_blocked_count = 0

    for turn in range(1, max_turns + 1):
        coverage = _requirement_target_coverage(req_payload, catalog, visual_refs, search_queries); remaining = max_turns - turn
        try:
            effective = user_text + _state_note(visual_refs, text_refs, search_queries, findings, pending_by_topic, coverage, remaining)
            if remaining <= 4: effective += "\nTURN BUDGET LOW: prioritize unresolved high-value evidence; budget exhaustion is not compliance."
            response = call_conversation_json(config, INVESTIGATOR_SYSTEM, history, effective, images=current_images,
                                              timeout=240.0, operation="vision" if current_images else "text_verify")
        except Exception as exc:
            errors.append(f"turn {turn}: {type(exc).__name__}: {exc}"); break
        append_turn(history, _history_user_text(effective, turn == 1), response)
        action = str(response.get("action") or "").strip().casefold(); action_counts[action or "invalid"] += 1
        transcript.append({"turn": turn, "action": action, "reason": str(response.get("reason") or "")[:500]}); current_images = []

        if action == "search":
            query = str(response.get("query") or "").strip()
            if query: search_queries.append(query)
            user_text = "TOOL RESULT: search navigation only.\n" + json.dumps(_search(catalog, query, 14), ensure_ascii=False) + "\nChoose next action."; continue
        if action == "read_text":
            requested = _normalize_refs(response.get("refs"), refs, MAX_TEXT_PAGES)
            if not requested: user_text = "TOOL ERROR: no valid refs for read_text."; continue
            text_refs.update(requested); user_text = _tool_text(requested, refs) + "\nUse only what the text actually states."; continue
        if action == "inspect_pages":
            requested = _normalize_refs(response.get("refs"), refs, MAX_PAGES)
            if not requested: user_text = "TOOL ERROR: no valid refs."; continue
            user_text, current_images, rendered, failures = _tool_pages(requested, refs); visual_refs.update(rendered); text_refs.update(requested); tool_failures.extend(failures)
            user_text += "\nRender failure is uncertainty, not absence."; continue
        if action == "zoom":
            regions = response.get("regions") if isinstance(response.get("regions"), list) else []
            user_text, current_images, accepted, failures = _tool_zoom(regions, refs); tool_failures.extend(failures)
            if not accepted: user_text += "\nNo valid rendered local regions. Choose another region/page."; continue
            zoomed.extend(accepted); visual_refs.update(r["ref"] for r in accepted); continue
        if action == "propose_finding":
            candidate = _normalize_candidate(response.get("finding"), refs)
            if candidate is None: user_text = "CANDIDATE REJECTED: missing direct observations/difference/valid refs."; continue
            key = _candidate_key(candidate)
            if key in seen_candidate_keys: user_text = "Exact candidate already verified. Add evidence or investigate elsewhere."; continue
            seen_candidate_keys.add(key); verification = _verify_candidate(config, candidate, refs, req_by_id)
            row = {"candidate": candidate, "verification": verification, "turn": turn}; verification_rows.append(row); topic = _topic_key(candidate)
            if _confirmed(candidate, verification):
                pending_by_topic.pop(topic, None)
                if topic not in confirmed_topics: findings.append(_finding_from(candidate, verification)); confirmed_topics.add(topic)
                user_text = "VERIFIER: CONFIRMED. Saved. Continue searching for independent changes and uncovered requirements."
            else:
                pending_by_topic[topic] = row
                user_text = ("VERIFIER: " + str(verification.get("verdict") or "needs_more").upper() + "\nREASON: "
                             + str(verification.get("reason") or "")[:1200] + "\nMISSING: "
                             + json.dumps(verification.get("missing_evidence") or [], ensure_ascii=False)
                             + "\nGather missing evidence if material, then propose a revised candidate.")
            continue
        if action == "finish":
            coverage = _requirement_target_coverage(req_payload, catalog, visual_refs, search_queries); blockers = coverage.get("blockers") or []
            if not finish_requested:
                finish_requested = True; user_text = ("SELF-REVIEW BEFORE FINISH: audit false negatives, multi-room targets, schematic-vs-plan, "
                    "requirements without RD evidence, legends/specifications/adjacent sheets, verifier needs_more, and tool failures.\nCOVERAGE BLOCKERS:\n"
                    + json.dumps(blockers[:24], ensure_ascii=False)); continue
            if blockers:
                finish_blocked_count += 1; user_text = "FINISH BLOCKED (not a compliance claim). Resolve/search these targets:\n" + json.dumps(blockers[:24], ensure_ascii=False); continue
            self_reviewed = finished = True; break
        user_text = "INVALID ACTION. Use search, read_text, inspect_pages, zoom, propose_finding, or finish."

    coverage = _requirement_target_coverage(req_payload, catalog, visual_refs, search_queries); unresolved = list(pending_by_topic.values())
    diagnostics = {
        "architecture": "stateful_investigator->python_tools->inline_independent_verifier->self_review",
        "model": config.resolved_model(), "blind_mode": blind_mode(), "learned_lessons_enabled": not blind_mode(),
        "max_turns": max_turns, "max_turns_cap": MAX_TURNS_CAP, "turns_used": len(transcript), "finished": finished,
        "finish_requested": finish_requested, "self_reviewed": self_reviewed, "finish_blocked_count": finish_blocked_count,
        "turn_budget_exhausted": not finished and len(transcript) >= max_turns, "action_counts": dict(action_counts), "pages_total": len(catalog),
        "pages_inspected": len(visual_refs), "visual_refs": sorted(visual_refs), "text_pages_read": len(text_refs), "text_refs": sorted(text_refs),
        "search_queries_total": len(search_queries), "zoom_regions_total": len(zoomed), "zoom_regions": zoomed, "requirements_total": len(requirements),
        "requirement_target_coverage": coverage, "candidates_total": len(verification_rows), "confirmed_total": len(findings), "unresolved_total": len(unresolved),
        "verifier_needs_more": sum(str((r.get("verification") or {}).get("verdict") or "").casefold() == "needs_more" for r in verification_rows),
        "verifier_rejected": sum(str((r.get("verification") or {}).get("verdict") or "").casefold() == "rejected" for r in verification_rows),
        "verifier_errors": sum(bool((r.get("verification") or {}).get("error")) for r in verification_rows), "tool_failures": tool_failures,
        "errors": errors, "transcript": transcript, "verification": verification_rows,
    }
    return InvestigatorResult(findings=findings, candidates=unresolved, diagnostics=diagnostics)
