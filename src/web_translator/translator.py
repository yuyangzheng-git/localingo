"""Model loading and translation for the web-translator server."""

from __future__ import annotations

import os

from .prompt import (
    BATCH_SYSTEM_PROMPT,
    SYSTEM_PROMPT,
    format_batch_prompt,
    parse_batch_response,
)

DEFAULT_MODEL = os.path.expanduser("~/models/qwen3-1.7b-web-v3a-mlx")


class Translator:
    """Wraps an MLX chat model and translates text segments EN -> zh-CN."""

    def __init__(self, model_id: str | None = None, adapter_path: str | None = None) -> None:
        self.model_id = model_id or os.environ.get("WEB_TRANSLATOR_MODEL", DEFAULT_MODEL)
        self.adapter_path = adapter_path or os.environ.get("WEB_TRANSLATOR_ADAPTER") or None
        self.model = None
        self.tokenizer = None

    @property
    def loaded(self) -> bool:
        return self.model is not None

    def load(self) -> None:
        """Load the model and tokenizer (no-op if already loaded)."""
        if self.loaded:
            return
        from mlx_lm import load

        self.model, self.tokenizer = load(self.model_id, adapter_path=self.adapter_path)

    def _generate(self, messages: list[dict], max_tokens: int) -> str:
        from mlx_lm import generate

        prompt = self.tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
            enable_thinking=False,
        )
        return generate(
            self.model,
            self.tokenizer,
            prompt=prompt,
            max_tokens=max_tokens,
        )

    def translate_one(self, text: str) -> str:
        """Translate a single segment."""
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": text},
        ]
        return self._generate(messages, max_tokens=256).strip()

    def translate_batch(self, texts: list[str]) -> list[str]:
        """Translate a list of segments, preserving order and length."""
        if not texts:
            return []
        if len(texts) == 1:
            return [self.translate_one(texts[0])]

        messages = [
            {"role": "system", "content": BATCH_SYSTEM_PROMPT},
            {"role": "user", "content": format_batch_prompt(texts)},
        ]
        raw = self._generate(messages, max_tokens=len(texts) * 128 + 64)
        translations = parse_batch_response(raw, len(texts))

        # Fall back to per-item translation for anything the model dropped or mangled.
        for i, text in enumerate(texts):
            if not translations[i]:
                translations[i] = self.translate_one(text)
        return translations
