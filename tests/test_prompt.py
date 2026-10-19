from web_translator.prompt import format_batch_prompt, parse_batch_response


def test_parse_basic_and_numeric_content():
    assert parse_batch_response("1. 你好\n2. 2024年\n3) 再见", 3) == ["你好", "2024年", "再见"]


def test_parse_missing_and_out_of_range_lines_become_empty():
    assert parse_batch_response("2. 二\n5. 五\nnoise", 3) == ["", "二", ""]


def test_parse_keeps_first_answer_for_duplicate_numbers():
    assert parse_batch_response("1. 第一\n1. 重复", 1) == ["第一"]


def test_format_collapses_newlines_inside_segments():
    assert format_batch_prompt(["line a\nline b", "c"]) == "1. line a line b\n2. c"
