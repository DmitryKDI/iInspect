from __future__ import annotations

from app.llm_runtime import AdaptiveLimiter, measure_run


def test_provider_queue_wait_is_visible_in_run_metrics():
    limiter = AdaptiveLimiter(1)
    limiter.rate_limited(0.02)

    with measure_run("queue-test") as measured:
        with limiter.slot():
            pass

    snapshot = measured.snapshot()
    assert snapshot["provider_queue_events"] == 1
    assert snapshot["provider_slot_acquired"] == 1
    assert snapshot["provider_queue_wait_seconds"] > 0
    assert snapshot["mean_provider_queue_wait_seconds"] > 0


def test_provider_metrics_exist_even_without_wait():
    with measure_run("queue-empty") as measured:
        pass

    snapshot = measured.snapshot()
    assert snapshot["provider_queue_events"] == 0
    assert snapshot["provider_queue_wait_seconds"] == 0.0
    assert snapshot["mean_provider_queue_wait_seconds"] == 0.0
