"""Unified LLM access with automatic fallback between two free backends.

Text generation tries the configured PRIMARY_LLM first ("gemini" or "ollama")
and falls back to the other one on any failure (missing key, network error,
rate limit, model not pulled, etc). Embeddings always go through Ollama
locally so the vector store never depends on which generation backend
is active.
"""

import json
import re

import ollama

from core import config

_last_backend_used = None


def last_backend_used():
    return _last_backend_used


class LLMError(Exception):
    pass


def _call_gemini(prompt: str, system: str | None, json_mode: bool) -> str:
    if not config.GEMINI_API_KEY:
        raise LLMError("GEMINI_API_KEY not set")
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=config.GEMINI_API_KEY)
    cfg = types.GenerateContentConfig(
        system_instruction=system,
        response_mime_type="application/json" if json_mode else None,
    )
    response = client.models.generate_content(
        model=config.GEMINI_MODEL, contents=prompt, config=cfg
    )
    if not response.text:
        raise LLMError("Gemini returned empty response")
    return response.text


def _call_ollama(prompt: str, system: str | None, json_mode: bool) -> str:
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    response = ollama.chat(
        model=config.OLLAMA_MODEL,
        messages=messages,
        format="json" if json_mode else None,
        # Ollama silently truncates to a small default context window (often
        # 2048-4096 tokens) regardless of the model's real capacity unless
        # the caller asks for more -- our prompts (a whole paper section, or
        # several) routinely exceed that, so content was quietly getting
        # dropped from what the model actually saw.
        options={"num_ctx": config.OLLAMA_NUM_CTX},
    )
    content = response["message"]["content"]
    if not content:
        raise LLMError("Ollama returned empty response")
    return content


_BACKENDS = {"gemini": _call_gemini, "ollama": _call_ollama}


def generate(prompt: str, system: str | None = None, json_mode: bool = False) -> str:
    """Generate text, trying the primary backend then falling back."""
    global _last_backend_used
    order = [config.PRIMARY_LLM] + [b for b in _BACKENDS if b != config.PRIMARY_LLM]
    errors = []
    for name in order:
        try:
            text = _BACKENDS[name](prompt, system, json_mode)
            _last_backend_used = name
            return text
        except Exception as e:  # noqa: BLE001 - deliberately broad, we fall back
            errors.append(f"{name}: {e}")
    raise LLMError("All LLM backends failed:\n" + "\n".join(errors))


def _fix_latex_backslashes(raw: str) -> str:
    """Models asked for JSON containing LaTeX routinely emit single backslashes
    (\\text, \\tau, \\frac, \\rho...) instead of the doubled ones JSON requires.
    Because \\t \\n \\r \\b \\f are themselves valid single-char JSON escapes,
    json.loads doesn't error on these -- it silently decodes them as literal
    control characters, mangling the LaTeX (e.g. "\\text" becomes a tab
    followed by "ext"). Walk the string and double any backslash that isn't
    already part of an escaped pair or a legitimate \\" / \\/ escape.
    """
    out = []
    i, n = 0, len(raw)
    while i < n:
        ch = raw[i]
        if ch == "\\" and i + 1 < n:
            nxt = raw[i + 1]
            if nxt == "\\" or nxt in '"/':
                out.append(ch + nxt)
            else:
                out.append("\\\\" + nxt)
            i += 2
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def generate_json(prompt: str, system: str | None = None) -> dict | list:
    """Generate and parse JSON, tolerant of models that wrap it in prose/fences
    or under-escape LaTeX backslashes."""
    raw = generate(prompt, system=system, json_mode=True)
    fixed = _fix_latex_backslashes(raw)
    try:
        return json.loads(fixed)
    except json.JSONDecodeError:
        pass
    match = re.search(r"\{.*\}|\[.*\]", fixed, re.DOTALL)
    if match:
        return json.loads(match.group(0))
    raise LLMError(f"Could not parse JSON from model output:\n{raw[:500]}")


def embed(text: str) -> list[float]:
    """Local, free embedding via Ollama. Used for all vector-store storage/search."""
    response = ollama.embed(model=config.OLLAMA_EMBED_MODEL, input=text)
    return response.embeddings[0]


def list_ollama_models() -> list[str]:
    """Locally-available Ollama models, for the Settings screen's model
    picker. Returns an empty list (rather than raising) if Ollama isn't
    reachable, so the UI can show a friendly "not running" state instead."""
    try:
        response = ollama.list()
        return [m.model for m in response.models]
    except Exception:  # noqa: BLE001 - Ollama may simply not be running
        return []
