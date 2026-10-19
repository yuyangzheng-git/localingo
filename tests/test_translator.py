from web_translator import translator
from web_translator.translator import Translator, _max_tokens_for


def test_max_tokens_scales_with_input():
    assert _max_tokens_for("short") == 128
    assert _max_tokens_for("x" * 2000) > 256
    assert _max_tokens_for("x" * 100_000) == 2048


def test_falls_back_to_hub_model_when_local_missing(monkeypatch, tmp_path):
    monkeypatch.delenv("WEB_TRANSLATOR_MODEL", raising=False)
    monkeypatch.setattr(translator, "DEFAULT_MODEL", str(tmp_path / "missing"))
    assert Translator().model_id == translator.FALLBACK_MODEL


def test_batch_falls_back_per_item_for_dropped_lines(monkeypatch):
    t = Translator(model_id="fake")
    calls = []

    def fake_generate(messages, max_tokens):
        calls.append(messages[-1]["content"])
        if len(calls) == 1:
            return "1. 一\n3. 三"
        return "二"

    monkeypatch.setattr(t, "_generate", fake_generate)
    assert t.translate_batch(["one", "two", "three"]) == ["一", "二", "三"]
    assert calls[1] == "two"
