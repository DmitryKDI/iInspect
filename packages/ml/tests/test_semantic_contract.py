from __future__ import annotations

from app.semantic_contract import (
    APPEARS_COMPLIANT,
    BBOX_AREA_MAX,
    BBOX_AREA_MIN,
    NOT_OBSERVED_ON_THIS_EVIDENCE,
    SAFE_COVERAGE_MIN,
    finding_can_confirm,
    normalize_finding,
    normalize_regions,
    safe_no_change,
)


def _finding(kind="configuration", **overrides):
    row = {
        "state": "OBSERVED_CONTRADICTION",
        "pd_claim": "PD A",
        "pd_evidence_ref": "PD bbox",
        "rd_claim": "RD B",
        "rd_evidence_ref": "RD bbox",
        "difference": "A != B",
        "difference_kind": kind,
        "evidence_scope": "complete",
        "coverage_pct": 0.8,
        "absence_verified": False,
        "corroboration_refs": [],
        "requires_additional_evidence": False,
    }
    row.update(overrides)
    return normalize_finding(row)


def test_whole_page_region_is_rejected():
    assert normalize_regions([{"rd_bbox_norm": [0, 0, 1, 1]}]) == []


def test_oversized_region_is_rejected():
    assert normalize_regions([{"rd_bbox_norm": [0, 0, 0.6, 0.5]}]) == []


def test_tiny_region_is_rejected():
    assert normalize_regions([{"rd_bbox_norm": [0, 0, 0.01, 0.01]}]) == []


def test_local_regions_are_diverse_and_bounded():
    regions = normalize_regions([
        {"rd_bbox_norm": [0.05, 0.05, 0.30, 0.30], "priority": "high"},
        {"rd_bbox_norm": [0.06, 0.06, 0.31, 0.31], "priority": "high"},
        {"rd_bbox_norm": [0.60, 0.60, 0.85, 0.85], "priority": "medium"},
    ])
    assert len(regions) == 2
    assert all(BBOX_AREA_MIN <= row["area"] <= BBOX_AREA_MAX for row in regions)


def test_configuration_can_confirm_after_local_high_scope():
    finding = _finding()
    assert finding is not None
    assert finding_can_confirm(
        finding,
        comparability="high",
        local_verified=True,
        scope_state="OBSERVED_CONTRADICTION",
    )


def test_absence_needs_complete_coverage_and_two_corroborations():
    finding = _finding("presence_absence", absence_verified=True)
    assert finding is not None
    assert not finding_can_confirm(
        finding,
        comparability="high",
        local_verified=True,
        scope_state="OBSERVED_CONTRADICTION",
    )
    finding["corroboration_refs"] = ["schedule page 7"]
    assert not finding_can_confirm(
        finding,
        comparability="high",
        local_verified=True,
        scope_state="OBSERVED_CONTRADICTION",
    )
    finding["corroboration_refs"] = ["schedule page 7", "detail page 8"]
    assert finding_can_confirm(
        finding,
        comparability="high",
        local_verified=True,
        scope_state="OBSERVED_CONTRADICTION",
    )
    finding["coverage_pct"] = SAFE_COVERAGE_MIN - 0.01
    assert not finding_can_confirm(
        finding,
        comparability="high",
        local_verified=True,
        scope_state="OBSERVED_CONTRADICTION",
    )


def test_not_observed_never_confirms_finding():
    finding = _finding()
    assert finding is not None
    assert not finding_can_confirm(
        finding,
        comparability="high",
        local_verified=True,
        scope_state=NOT_OBSERVED_ON_THIS_EVIDENCE,
    )


def test_safe_no_change_requires_local_coverage_and_clean_state():
    kwargs = dict(
        state=APPEARS_COMPLIANT,
        comparability="high",
        pd_inventory=[{"entity": "a"}],
        rd_inventory=[{"entity": "a"}],
        required_regions=2,
        pending_high_regions=False,
        errors=[],
        cache_only=False,
        coverage_pct=0.8,
    )
    assert not safe_no_change(checked_regions=1, **kwargs)
    assert safe_no_change(checked_regions=2, **kwargs)
    assert not safe_no_change(checked_regions=2, coverage_pct=0.5, **{k: v for k, v in kwargs.items() if k != "coverage_pct"})
    assert not safe_no_change(checked_regions=2, provider_error="timeout", **kwargs)
    assert not safe_no_change(checked_regions=2, scope_match=False, **kwargs)
    assert not safe_no_change(checked_regions=2, cache_only=True, **{k: v for k, v in kwargs.items() if k != "cache_only"})
