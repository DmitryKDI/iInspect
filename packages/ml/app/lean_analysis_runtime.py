"""Lean active PD -> RD/ID analysis runtime.

Active architecture:
    document map + PD requirements
        -> one stateful investigator session with Python tools
        -> self-review for missed evidence
        -> independent verifier for every proposed finding.

Legacy pair/room/equipment/routing/verdict runtimes remain compatibility code
only. They do not gate the active analysis.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from time import perf_counter
from typing import Optional

from .facts_store import facts_for
from .llm import LlmConfig, model_configured
from .matching import DocumentInput
from .requirement_llm_extract import extract_requirements_llm
from .requirement_registry import Requirement, extract_requirements
from .stateful_investigator import InvestigatorResult, run_stateful_investigator


@dataclass
class DocumentLoadResult:
    docs: list[DocumentInput] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    paths: list[str] = field(default_factory=list)
    incomplete: list[str] = field(default_factory=list)


def _elapsed(started: float) -> float:
    return round(perf_counter() - started, 4)


def _load_documents(paths: list[str], names: Optional[list[str]] = None) -> DocumentLoadResult:
    out: list[DocumentInput] = []
    skipped: list[str] = []
    loaded_paths: list[str] = []
    incomplete: list[str] = []
    for index, raw_path in enumerate(paths):
        source = Path(raw_path)
        display_name = names[index] if names and index < len(names) else source.name
        if not source.is_file():
            skipped.append(f"{display_name}: не найден")
            continue
        try:
            facts = facts_for(str(source), display_name)
        except Exception as exc:  # noqa: BLE001
            skipped.append(f"{display_name}: {type(exc).__name__}: {exc}")
            continue
        out.append(DocumentInput(
            name=display_name,
            pages=facts.pages,
            text_facts=facts.text_facts,
            room_facts=facts.room_facts,
            discipline_code=getattr(facts, "discipline_code", None),
            page_kinds=facts.page_kinds,
            equipment_facts=facts.equipment_facts,
            balance_facts=facts.balance_facts,
        ))
        loaded_paths.append(str(source))
        if getattr(facts, "ocr_status", "not_required") not in ("not_required", "done"):
            incomplete.append(f"{display_name}: распознавание текста не завершено")
    return DocumentLoadResult(out, skipped, loaded_paths, incomplete)


def _load_text_facts(paths: list[str], names: Optional[list[str]] = None) -> list[dict]:
    return _document_text_facts(_load_documents(paths, names).docs)


def _document_text_facts(documents: list[DocumentInput]) -> list[dict]:
    """Используем тот же разбор, что карта листов: в нём сохранён результат OCR."""
    out: list[dict] = []
    for document in documents:
        for fact in document.text_facts:
            if not str(fact.get("text") or "").strip():
                continue
            out.append({
                **fact,
                "fact_id": len(out) + 1,
                "document": document.name,
                "section": fact.get("section") or document.discipline_code or "",
            })
    return out


def _investigation_complete(investigator: InvestigatorResult | None) -> bool:
    if investigator is None:
        return False
    diagnostics = investigator.diagnostics
    return bool(
        diagnostics.get("finished") and diagnostics.get("self_reviewed")
        and not diagnostics.get("turn_budget_exhausted")
        and not diagnostics.get("errors") and not diagnostics.get("tool_failures")
        and not diagnostics.get("verifier_errors")
    )


def _requirement_row(index: int, req: Requirement, finding_ids: set[str]) -> dict:
    req_id = f"R{index}"
    linked = req_id in finding_ids
    return {
        "id": req_id,
        "status": "требует проверки",
        "requirement": req.summary or req.sentence,
        "sentence": req.sentence,
        "document": req.document,
        "page": req.page,
        "rooms": list(req.rooms or req.rooms_by_name or []),
        "confirmed_contradiction": linked,
        "reason": (
            "independent verifier подтвердил связанное расхождение"
            if linked
            else "требование включено в stateful investigation; отсутствие finding не считается доказательством соответствия"
        ),
    }


def _requirements_payload(requirements: list[Requirement], investigator: InvestigatorResult | None) -> dict:
    linked_ids = {
        req_id
        for finding in (investigator.findings if investigator else [])
        for req_id in finding.get("requirement_ids") or []
    }
    items = [_requirement_row(index, req, linked_ids) for index, req in enumerate(requirements, 1)]
    counts = {"требует проверки": len(items)} if items else {}
    diagnostics = {
        "architecture": "requirements_as_investigator_context",
        "requirements_total": len(items),
        "linked_confirmed_contradictions": len(linked_ids),
        "no_finding_is_not_compliance": True,
    }
    if investigator:
        diagnostics["investigator_turns"] = investigator.diagnostics.get("turns_used")
        diagnostics["pages_inspected"] = investigator.diagnostics.get("pages_inspected")
    return {"counts": counts, "not_run": [], "diagnostics": diagnostics, "items": items}


def _pair_compat_payload(investigator: InvestigatorResult | None) -> dict:
    if investigator is None:
        return {"counts": {}, "results": [], "coverage": {}}
    confirmed = len(investigator.findings)
    unresolved = len(investigator.candidates)
    counts = {}
    if confirmed:
        counts["confirmed_difference"] = confirmed
    if unresolved:
        counts["candidate_difference_unverified"] = unresolved
    coverage = {
        "status": "complete" if _investigation_complete(investigator) else "incomplete",
        "semantic_architecture": investigator.diagnostics.get("architecture"),
        "pages_total": investigator.diagnostics.get("pages_total"),
        "pages_inspected": investigator.diagnostics.get("pages_inspected"),
        "turns_used": investigator.diagnostics.get("turns_used"),
        "max_turns": investigator.diagnostics.get("max_turns"),
        "self_reviewed": investigator.diagnostics.get("self_reviewed"),
        "turn_budget_exhausted": investigator.diagnostics.get("turn_budget_exhausted"),
        "action_counts": investigator.diagnostics.get("action_counts") or {},
        "zoom_regions_total": investigator.diagnostics.get("zoom_regions_total"),
        "requirements_total": investigator.diagnostics.get("requirements_total"),
        "candidates_total": investigator.diagnostics.get("candidates_total"),
        "confirmed_total": investigator.diagnostics.get("confirmed_total"),
        "unresolved_total": investigator.diagnostics.get("unresolved_total"),
        "verifier_errors": investigator.diagnostics.get("verifier_errors"),
        "errors": investigator.diagnostics.get("errors") or [],
    }
    results = []
    for row in investigator.diagnostics.get("verification") or []:
        candidate = row.get("candidate") if isinstance(row, dict) else {}
        verification = row.get("verification") if isinstance(row, dict) else {}
        if not isinstance(candidate, dict):
            candidate = {}
        if not isinstance(verification, dict):
            verification = {}
        kind = str(verification.get("difference_kind") or candidate.get("difference_kind") or "").strip().casefold()
        is_confirmed = (
            str(verification.get("verdict") or "").casefold() == "confirmed"
            and bool(verification.get("scope_sufficient"))
            and (kind != "presence_absence" or bool(verification.get("absence_scope_complete")))
        )
        results.append({
            "control_type": "investigator_candidate",
            "pair_key": "|".join(list(candidate.get("pd_refs") or []) + list(candidate.get("rd_refs") or [])),
            "status": "confirmed_difference" if is_confirmed else "candidate_difference_unverified",
            "confirmed_findings": [candidate] if is_confirmed else [],
            "unverified_candidates": [] if is_confirmed else [candidate],
            "verification": verification,
        })
    return {"counts": counts, "results": results, "coverage": coverage}


def run_lean_analysis(
    before_paths: list[str],
    after_paths: list[str],
    room_keys: Optional[list[str]] = None,
    llm_config: Optional[LlmConfig] = None,
    before_names: Optional[list[str]] = None,
    after_names: Optional[list[str]] = None,
) -> dict:
    """Run the stateful blind-safe semantic investigator.

    ``room_keys`` remains only for API compatibility and cannot gate execution.
    """
    del room_keys
    timings: dict[str, float] = {}
    total_started = perf_counter()

    stage = perf_counter()
    before = _load_documents(before_paths, before_names)
    after = _load_documents(after_paths, after_names)
    timings["load_documents"] = _elapsed(stage)
    skipped = before.skipped + after.skipped
    if not before.docs or not after.docs:
        timings["total"] = _elapsed(total_started)
        return {
            "valid": False,
            "reason": (
                f"прогон недействителен: сторона "
                f"{'ПД' if not before.docs else 'РД'} пуста "
                f"(ПД {len(before.docs)}/{len(before_paths)}, РД {len(after.docs)}/{len(after_paths)})"
            ),
            "skipped_files": skipped,
            "performance": {"stages_seconds": timings, "duration_seconds": timings["total"]},
            "active_architecture": "stateful_investigator",
        }

    # Прежнее условие прямо исключало локального провайдера — графический
    # исследователь выключался бы ровно в той конфигурации, в которой идёт
    # зачётный прогон.
    use_llm = model_configured(llm_config)
    call_failures: list[str] = before.incomplete + after.incomplete

    stage = perf_counter()
    pd_text_facts = _document_text_facts(before.docs)
    timings["load_pd_text"] = _elapsed(stage)

    stage = perf_counter()
    if use_llm:
        def _on_extract_error(page: int, exc: Exception) -> None:
            call_failures.append(f"requirements_llm_extract стр.{page}+: {exc!r}")

        requirements = extract_requirements_llm(
            pd_text_facts,
            llm_config,  # type: ignore[arg-type]
            on_chunk_error=_on_extract_error,
        )
        requirement_source = "llm"
    else:
        requirements = extract_requirements(pd_text_facts)
        requirement_source = "regex_fallback"
    timings["requirements_extract"] = _elapsed(stage)

    investigator: InvestigatorResult | None = None
    stage = perf_counter()
    if use_llm:
        try:
            investigator = run_stateful_investigator(
                before.docs,
                after.docs,
                before.paths,
                after.paths,
                requirements,
                llm_config,  # type: ignore[arg-type]
            )
        except Exception as exc:  # noqa: BLE001
            call_failures.append(f"stateful_investigator: {type(exc).__name__}: {exc}")
    timings["stateful_investigation"] = _elapsed(stage)
    timings["total"] = _elapsed(total_started)

    requirement_payload = _requirements_payload(requirements, investigator)
    if not use_llm:
        requirement_payload["not_run"] = ["stateful investigator — no AI key"]

    pair_payload = _pair_compat_payload(investigator)
    valid = not skipped and not call_failures and _investigation_complete(investigator)
    if not valid and pair_payload["coverage"]:
        pair_payload["coverage"]["status"] = "incomplete"
    semantic_findings = list(investigator.findings if investigator else [])
    semantic_candidates = list(investigator.candidates if investigator else [])

    return {
        "valid": valid,
        "reason": "" if valid else (
            "Прогон выполнен частично: есть пропущенные документы, "
            "ошибки распознавания или незавершённые проверки. "
            "Отсутствие находок не доказывает соответствие."
        ),
        "documents": {
            "before": [doc.name for doc in before.docs],
            "after": [doc.name for doc in after.docs],
        },
        "skipped_files": skipped,
        "llm": {
            "used": use_llm,
            "provider": llm_config.provider if llm_config else None,
            "call_failures": call_failures,
        },
        "not_run": (["stateful semantic investigation: модель не подключена"] if not use_llm else []),
        "performance": {"duration_seconds": timings["total"], "stages_seconds": timings},
        "active_architecture": (
            "PD document map + requirements -> stateful local-model investigator "
            "-> Python page/search/zoom tools -> self-review -> independent verifier"
        ),
        "semantic_contract": {
            "states": [
                "OBSERVED_CONTRADICTION",
                "NOT_OBSERVED_ON_THIS_EVIDENCE",
                "WRONG_OR_INSUFFICIENT_SCOPE",
                "APPEARS_COMPLIANT",
            ],
            "absence_from_not_observed_forbidden": True,
            "investigator_can_confirm_directly": False,
            "independent_verifier_required": True,
            "stateful_history": True,
            "learned_experience_disabled_in_blind_mode": True,
        },
        "requirements": {
            "source": requirement_source,
            "total": len(requirements),
            "compliance": requirement_payload,
        },
        "vision_requirements": requirement_payload,
        "pair_vision": pair_payload,
        "investigator": investigator.diagnostics if investigator else {
            "architecture": "stateful_investigator",
            "status": "not_run",
        },
        "semantic_findings": semantic_findings,
        "semantic_candidates": semantic_candidates,
        "rooms": {"active": False, "findings": [], "signals_total": 0},
        "equipment": {"active": False, "findings": [], "signals_total": 0},
        "composition": {"active": False, "findings": []},
        "routing": None,
        "triangulation": {
            "active": False,
            "signals_count": len(semantic_findings),
            "confirmed": semantic_findings,
            "candidates": semantic_candidates,
        },
        "verdicts": [],
        "escalation_tickets": [],
        "legacy_runtime": {
            "room_registry": False,
            "equipment_registry": False,
            "composition_registry": False,
            "routing_diff": False,
            "general_requirement_filter": False,
            "legacy_compliance_ladder": False,
            "verdict_synthesis": False,
            "mandatory_triangulation": False,
            "isolated_pair_micro_prompts": False,
            "isolated_requirement_micro_prompts": False,
        },
    }
