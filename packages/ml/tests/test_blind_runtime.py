from app import vision
from app.requirement_llm_extract import requirement_extraction_system_prompt


def test_known_examples_are_empty_for_blind_runtime():
    assert vision.load_known_violations() == []
    assert vision.known_violations_block("drawing", "OV") == ""
    assert vision.known_violations_block("text", "KR") == ""


def test_runtime_prompts_have_no_example_block():
    prompts = [
        vision.vision_system_prompt("OV"),
        vision.text_compare_system_prompt("OV"),
        requirement_extraction_system_prompt("OV"),
    ]
    assert all("already seen" not in prompt.lower() for prompt in prompts)
