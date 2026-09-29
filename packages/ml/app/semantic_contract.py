"""Universal semantic evidence contract for PD -> RD/ID comparison.

The contract is intentionally modality-neutral. A PD claim may come from text
or a drawing; RD evidence may come from a plan, schematic, detail, schedule or
text. What changes is the attachment, not the meaning of the result.

Core rule: NOT_OBSERVED_ON_THIS_EVIDENCE is never promoted to absence. A
presence/absence contradiction needs explicit scope and local evidence; when
scope is insufficient the result remains a candidate/unclear state.
"""
from __future__ import annotations

from typing import Iterable

OBSERVED_CONTRADICTION = "OBSERVED_CONTRADICTION"
NOT_OBSERVED_ON_THIS_EVIDENCE = "NOT_OBSERVED_ON_THIS_EVIDENCE"
WRONG_OR_INSUFFICIENT_SCOPE = "WRONG_OR_INSUFFICIENT_SCOPE"
APPEARS_COMPLIANT = "APPEARS_COMPLIANT"

SEMANTIC_STATES = {
    OBSERVED_CONTRADICTION,
    NOT_OBSERVED_ON_THIS_EVIDENCE,
    WRONG_OR_INSUFFICIENT_SCOPE,
    APPEARS_COMPLIANT,
}

SHEET_TYPES = {"SCHEMATIC", "PLAN", "RCP", "DETAIL", "SCHEDULE", "TEXT", "UNKNOWN"}
DIFFERENCE_KINDS = {
    "presence_absence", "configuration", "connection", "parameter", "topology",
    "quantity", "location", "coverage", "other",
}

REGIONS_PER_CALL = 3
BBOX_AREA_MIN = 0.02
BBOX_AREA_MAX = 0.25
BBOX_MAX_OVERLAP = 0.30
SAFE_COVERAGE_MIN = 0.75


def normalize_state(value: object) -> str:
    state = str(value or "").strip().upper()
    return state if state in SEMANTIC_STATES else WRONG_OR_INSUFFICIENT_SCOPE


def normalize_sheet_type(value: object) -> str:
    raw = str(value or "").strip().upper()
    aliases = {
        "SCHEME": "SCHEMATIC",
        "СХЕМА": "SCHEMATIC",
        "ПЛАН": "PLAN",
        "DETAILS": "DETAIL",
        "SPEC": "SCHEDULE",
        "SPECIFICATION": "SCHEDULE",
        "TABLE": "SCHEDULE",
    }
    raw = aliases.get(raw, raw)
    return raw if raw in SHEET_TYPES else "UNKNOWN"


def normalize_difference_kind(value: object) -> str:
    raw = str(value or "").strip().casefold().replace("-", "_").replace(" ", "_")
    aliases = {
        "absence": "presence_absence",
        "missing": "presence_absence",
        "removed": "presence_absence",
        "omitted": "presence_absence",
        "presence": "presence_absence",
        "config": "configuration",
        "route": "topology",
        "routing": "topology",
    }
    raw = aliases.get(raw, raw)
    return raw if raw in DIFFERENCE_KINDS else "other"


def normalize_bbox(value: object) -> tuple[float, float, float, float] | None:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    try:
        x1, y1, x2, y2 = (float(v) for v in value)
    except (TypeError, ValueError):
        return None
    x1, x2 = sorted((max(0.0, min(1.0, x1)), max(0.0, min(1.0, x2))))
    y1, y2 = sorted((max(0.0, min(1.0, y1)), max(0.0, min(1.0, y2))))
    if x2 <= x1 or y2 <= y1:
        return None
    return (x1, y1, x2, y2)


def bbox_area(box: tuple[float, float, float, float] | None) -> float:
    if box is None:
        return 0.0
    return max(0.0, box[2] - box[0]) * max(0.0, box[3] - box[1])


def _intersection(a, b) -> float:
    x1 = max(a[0], b[0])
    y1 = max(a[1], b[1])
    x2 = min(a[2], b[2])
    y2 = min(a[3], b[3])
    return max(0.0, x2 - x1) * max(0.0, y2 - y1)


def overlap_ratio(a, b) -> float:
    """Intersection relative to the smaller region."""
    denom = min(bbox_area(a), bbox_area(b))
    return _intersection(a, b) / denom if denom > 0 else 0.0


def normalize_regions(value: object, *, limit: int = REGIONS_PER_CALL) -> list[dict]:
    """Accept only genuinely local, diverse regions.

    Whole-page, oversized and tiny boxes are rejected. The caller can then
    request fresh region discovery instead of pretending that a broad crop was
    a local verification.
    """
    out: list[dict] = []
    rows = value if isinstance(value, list) else []
    for item in rows:
        if not isinstance(item, dict):
            continue
        rd_box = normalize_bbox(item.get("rd_bbox_norm") or item.get("bbox_norm"))
        if rd_box is None:
            continue
        area = bbox_area(rd_box)
        if area < BBOX_AREA_MIN or area > BBOX_AREA_MAX:
            continue
        pd_box = normalize_bbox(item.get("pd_bbox_norm"))
        if pd_box is not None:
            pd_area = bbox_area(pd_box)
            if pd_area < BBOX_AREA_MIN or pd_area > BBOX_AREA_MAX:
                pd_box = None
        if any(overlap_ratio(rd_box, old["rd_bbox_norm"]) > BBOX_MAX_OVERLAP for old in out):
            continue
        priority = str(item.get("priority") or "medium").strip().casefold()
        out.append({
            "reason": str(item.get("reason") or "").strip(),
            "pd_bbox_norm": pd_box,
            "rd_bbox_norm": rd_box,
            "priority": priority if priority in {"high", "medium", "low"} else "medium",
            "area": round(area, 6),
        })
        if len(out) >= max(1, min(REGIONS_PER_CALL, int(limit))):
            break
    return out


def normalize_inventory(value: object, *, limit: int = 80) -> list[dict]:
    out: list[dict] = []
    for item in value if isinstance(value, list) else []:
        if isinstance(item, dict):
            entity = str(item.get("entity") or "").strip()
            observation = str(item.get("observation") or "").strip()
            where = str(item.get("where") or "").strip()
            if entity or observation:
                out.append({"entity": entity, "observation": observation, "where": where})
        elif str(item).strip():
            out.append({"entity": "", "observation": str(item).strip(), "where": ""})
        if len(out) >= limit:
            break
    return out


def _bounded_fraction(value: object) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return max(0.0, min(1.0, number))


def _text_list(value: object) -> list[str]:
    return [str(x).strip() for x in value if str(x).strip()] if isinstance(value, list) else []


def normalize_finding(item: object) -> dict | None:
    if not isinstance(item, dict):
        return None
    state = normalize_state(item.get("state"))
    if state != OBSERVED_CONTRADICTION:
        return None
    fields = {
        "pd_claim": str(item.get("pd_claim") or "").strip(),
        "pd_evidence_ref": str(item.get("pd_evidence_ref") or item.get("pd_evidence") or "").strip(),
        "rd_claim": str(item.get("rd_claim") or "").strip(),
        "rd_evidence_ref": str(item.get("rd_evidence_ref") or item.get("rd_evidence") or "").strip(),
        "difference": str(item.get("difference") or "").strip(),
    }
    if not all(fields.values()):
        return None

    scope_check = item.get("scope_check") if isinstance(item.get("scope_check"), dict) else {}
    evidence_quality = item.get("evidence_quality") if isinstance(item.get("evidence_quality"), dict) else {}
    attempted_bboxes = []
    for raw in item.get("attempted_bboxes") or []:
        box = normalize_bbox(raw)
        if box is not None:
            attempted_bboxes.append(box)

    kind = normalize_difference_kind(item.get("difference_kind"))
    return {
        **fields,
        "state": state,
        "difference_kind": kind,
        "where": str(item.get("where") or "").strip(),
        "evidence_scope": str(item.get("evidence_scope") or "").strip().casefold(),
        "coverage_pct": _bounded_fraction(item.get("coverage_pct")),
        "absence_verified": bool(item.get("absence_verified")),
        "requires_additional_evidence": bool(item.get("requires_additional_evidence")),
        "corroboration_refs": _text_list(item.get("corroboration_refs")),
        "alternative_sheet_refs": _text_list(item.get("alternative_sheet_refs")),
        "attempted_sheets": _text_list(item.get("attempted_sheets")),
        "attempted_bboxes": attempted_bboxes,
        "zoom_request_reason": str(item.get("zoom_request_reason") or "").strip(),
        "scope_check": {
            "genre_required": scope_check.get("genre_required"),
            "scale_match": scope_check.get("scale_match"),
            "discipline_match": scope_check.get("discipline_match"),
            "reason": str(scope_check.get("reason") or "").strip(),
        },
        "evidence_quality": {
            "provider_error": str(evidence_quality.get("provider_error") or "").strip(),
            "unreadable_labels": _text_list(evidence_quality.get("unreadable_labels")),
        },
    }


def normalize_findings(value: object) -> list[dict]:
    rows = value if isinstance(value, list) else []
    out: list[dict] = []
    for row in rows:
        finding = normalize_finding(row)
        if finding is not None:
            out.append(finding)
    return out


def finding_needs_local_verification(finding: dict) -> bool:
    return True


def finding_can_confirm(
    finding: dict,
    *,
    comparability: str,
    local_verified: bool,
    scope_state: str,
) -> bool:
    if normalize_state(scope_state) in {WRONG_OR_INSUFFICIENT_SCOPE, NOT_OBSERVED_ON_THIS_EVIDENCE}:
        return False
    if comparability != "high" or not local_verified:
        return False
    if finding.get("requires_additional_evidence"):
        return False
    quality = finding.get("evidence_quality") if isinstance(finding.get("evidence_quality"), dict) else {}
    if quality.get("provider_error") or quality.get("unreadable_labels"):
        return False
    if finding.get("difference_kind") == "presence_absence":
        coverage = finding.get("coverage_pct")
        return (
            bool(finding.get("absence_verified"))
            and finding.get("evidence_scope") == "complete"
            and coverage is not None
            and coverage >= SAFE_COVERAGE_MIN
            and len(finding.get("corroboration_refs") or []) >= 2
        )
    return True


def safe_no_change(
    *,
    state: str,
    comparability: str,
    pd_inventory: Iterable[dict],
    rd_inventory: Iterable[dict],
    checked_regions: int,
    required_regions: int,
    pending_high_regions: bool,
    errors: Iterable[object],
    cache_only: bool = False,
    coverage_pct: float | None = None,
    provider_error: str = "",
    unreadable_labels: Iterable[str] = (),
    scope_match: bool = True,
    budget_exhausted: bool = False,
) -> bool:
    return (
        normalize_state(state) == APPEARS_COMPLIANT
        and comparability == "high"
        and bool(list(pd_inventory))
        and bool(list(rd_inventory))
        and checked_regions >= required_regions > 0
        and not pending_high_regions
        and not list(errors)
        and not cache_only
        and not provider_error
        and not list(unreadable_labels)
        and scope_match
        and not budget_exhausted
        and (coverage_pct is None or coverage_pct >= SAFE_COVERAGE_MIN)
    )
