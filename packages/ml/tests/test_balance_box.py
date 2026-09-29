import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.balance_box import extract_balance_facts


def test_balance_box_with_system_code_and_both_signs():
    text = "140\nП2/ВЕ\n+400\nм3/ч\n-400\nм3/ч"
    facts = extract_balance_facts(text, room_keys={"140"})
    assert len(facts) == 1, facts
    fact = facts[0]
    assert fact["room_key"] == "140"
    assert fact["system_code"] == "П2/ВЕ"
    assert fact["приток_м3ч"] == "400"
    assert fact["вытяжка_м3ч"] == "400"
    print("OK: баланс-рамка с кодом системы и обоими знаками разбирается целиком")


def test_number_not_in_room_keys_is_ignored():
    """Голое число рядом с +/- знаками, не являющееся номером помещения на
    этой странице (rooms.py его не нашёл) — не баланс-рамка."""
    text = "999\nП2/ВЕ\n+400\nм3/ч"
    facts = extract_balance_facts(text, room_keys={"140"})
    assert facts == [], facts
    print("OK: число вне реестра помещений страницы не порождает баланс-факт")


def test_signed_number_without_unit_is_not_balance():
    """Число со знаком, за которым не следует «м3/ч» — случайная величина
    (отметка, координата), не баланс притока/вытяжки."""
    text = "140\n+400\nмм"
    facts = extract_balance_facts(text, room_keys={"140"})
    assert facts == [], facts
    print("OK: число со знаком без единицы «м3/ч» не считается балансом")


def test_no_room_keys_returns_empty():
    text = "140\nП2/ВЕ\n+400\nм3/ч\n-400\nм3/ч"
    assert extract_balance_facts(text, room_keys=None) == []
    assert extract_balance_facts(text, room_keys=set()) == []
    print("OK: без переданного реестра помещений баланс не извлекается")


def test_only_inflow_present_is_still_registered():
    """У части систем (чисто приточных) вытяжки может не быть — факт всё
    равно регистрируется с тем, что нашлось, а не отбрасывается целиком."""
    text = "142\nП5/ВЕ\n+250\nм3/ч"
    facts = extract_balance_facts(text, room_keys={"142"})
    assert len(facts) == 1, facts
    assert facts[0]["приток_м3ч"] == "250"
    assert "вытяжка_м3ч" not in facts[0]
    print("OK: только приток без вытяжки — факт всё равно зарегистрирован")


if __name__ == "__main__":
    test_balance_box_with_system_code_and_both_signs()
    test_number_not_in_room_keys_is_ignored()
    test_signed_number_without_unit_is_not_balance()
    test_no_room_keys_returns_empty()
    test_only_inflow_present_is_still_registered()
    print("ALL PASS")
