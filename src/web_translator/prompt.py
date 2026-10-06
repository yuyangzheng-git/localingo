"""Prompt templates and response parsing for the translation model."""

# System prompt for translating a single segment (reused from the original prototype).
SYSTEM_PROMPT = (
    "You are an English-to-Simplified-Chinese webpage translation engine. "
    "Translate all human-readable English text into natural Simplified Chinese. "
    "Preserve URLs exactly. "
    "Preserve numbers and prices exactly. "
    "Do not translate product names such as MacBook Pro. "
    "For proper nouns, use an established Chinese name when one exists "
    "(e.g. Sydney→悉尼, New South Wales→新南威尔士州); otherwise transliterate the "
    "name phonetically and do not append generic nouns such as 族 or 城. "
    "Do not explain anything. "
    "Do not add anything. "
    "Output only the translation."
)

# System prompt for translating a numbered batch of segments in one request.
BATCH_SYSTEM_PROMPT = (
    "You are an English-to-Simplified-Chinese webpage translation engine. "
    "The user gives you a numbered list of text segments. "
    "Translate each segment into natural Simplified Chinese. "
    "Preserve URLs, numbers and prices exactly. "
    "Do not translate product names such as MacBook Pro. "
    "For proper nouns, use an established Chinese name when one exists, otherwise "
    "transliterate phonetically without appending generic nouns such as 族 or 城. "
    "Output each translation on its own line, prefixed with its original number "
    "and a space, in the same order. "
    "Do not skip, merge, or reorder lines. Do not add anything else."
)


def format_batch_prompt(texts: list[str]) -> str:
    """Format a list of segments as a numbered list for the model."""
    return "\n".join(f"{i + 1}. {text}" for i, text in enumerate(texts))


def parse_batch_response(response: str, expected: int) -> list[str]:
    """Parse ``1. 中文`` style lines back into an ordered list.

    Returns a list of length ``expected``; entries that could not be parsed
    become empty strings so the caller can fall back to per-item translation.
    """
    translations: list[str] = [""] * expected
    for raw in response.splitlines():
        line = raw.strip()
        if not line:
            continue
        i = 0
        while i < len(line) and line[i].isdigit():
            i += 1
        if i == 0:
            continue
        try:
            idx = int(line[:i])
        except ValueError:
            continue
        if not 1 <= idx <= expected:
            continue
        rest = line[i:].lstrip(".、)）:： \t")
        translations[idx - 1] = rest
    return translations
