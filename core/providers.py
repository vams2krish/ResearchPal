"""User-selected connections and capability routes. Servers own model files."""
import base64
import copy
import json
import os
import threading
from contextvars import ContextVar
from urllib.parse import urlparse

import requests
from core import config, model_storage

LOCK = threading.RLock()
SNAPSHOT = ContextVar("provider_snapshot", default=None)
KINDS = {"ollama", "gemini", "openrouter", "compatible", "comfyui", "automatic1111", "baidu", "unlimited_ocr"}
CAPABILITIES = {"text", "vision", "embedding", "image", "video", "speech", "ocr"}
SUPPORT = {
    "ollama": {"text", "vision", "embedding"}, "gemini": {"text", "vision"},
    "openrouter": {"text", "vision", "embedding", "image", "video", "speech"},
    "compatible": {"text", "vision", "embedding", "image", "video", "speech"},
    "comfyui": {"image", "video"}, "automatic1111": {"image"}, "baidu": {"ocr"}, "unlimited_ocr": {"ocr"},
}


def settings_path():
    return config.DATA_DIR / "connections.json"


def defaults():
    return {
        "providers": {
            "ollama": {"kind": "ollama", "name": "Ollama", "base_url": config.OLLAMA_HOST,
                       "models_dir": model_storage.environment_folder()},
            "gemini": {"kind": "gemini", "name": "Gemini", "base_url": "", "api_key": config.GEMINI_API_KEY},
            "openrouter": {"kind": "openrouter", "name": "OpenRouter", "base_url": "https://openrouter.ai/api/v1", "api_key": ""},
            "compatible": {"kind": "compatible", "name": "Custom compatible API", "base_url": "", "api_key": ""},
            "comfyui": {"kind": "comfyui", "name": "ComfyUI", "base_url": "http://127.0.0.1:8188", "workflow": {}, "prompt_node": "", "prompt_input": "text"},
            "automatic1111": {"kind": "automatic1111", "name": "Automatic1111", "base_url": "http://127.0.0.1:7860"},
            "baidu": {"kind": "baidu", "name": "Baidu OCR", "base_url": "https://aip.baidubce.com", "api_key": "", "secret_key": ""},
            "unlimited_ocr": {"kind": "unlimited_ocr", "name": "Baidu Unlimited-OCR 2", "base_url": "http://127.0.0.1:10000/v1", "custom_logit_processor": ""},
        },
        "routes": {
            "text": {"provider": config.PRIMARY_LLM, "model": config.OLLAMA_MODEL if config.PRIMARY_LLM == "ollama" else config.GEMINI_MODEL},
            "vision": {"provider": config.PRIMARY_LLM, "model": config.OLLAMA_VISION_MODEL if config.PRIMARY_LLM == "ollama" else config.GEMINI_MODEL},
            "embedding": {"provider": "ollama", "model": config.OLLAMA_EMBED_MODEL},
            "speech": {"provider": "browser", "model": ""},
            "image": {"provider": "", "model": ""}, "video": {"provider": "", "model": ""},
            "ocr": {"provider": "", "model": ""},
        },
        "ocr_mode": "auto", "allow_fallback": False,
    }


def load():
    if SNAPSHOT.get() is not None:
        return copy.deepcopy(SNAPSHOT.get())
    with LOCK:
        if settings_path().exists():
            return json.loads(settings_path().read_text(encoding="utf-8"))
        return defaults()


def public_settings():
    data = copy.deepcopy(load())
    for provider in data["providers"].values():
        for key in ("api_key", "secret_key"):
            provider["has_" + key] = bool(provider.pop(key, ""))
    return data


def validate_url(value):
    parsed = urlparse(value)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Use an http(s) base URL without credentials, query, or fragment")
    return value.rstrip("/")


def save(data):
    with LOCK:
        old = load()
        incoming = copy.deepcopy(data)
        for key, p in incoming.get("providers", {}).items():
            if not key.replace("_", "").replace("-", "").isalnum() or p.get("kind") not in KINDS:
                raise ValueError("Invalid provider ID or type")
            p["base_url"] = validate_url(p["base_url"]) if p.get("base_url") else ""
            for secret in ("api_key", "secret_key"):
                # Empty input keeps the stored secret. Explicit clear is separate.
                if not p.get(secret):
                    p[secret] = old["providers"].get(key, {}).get(secret, "")
                if p.pop("clear_" + secret, False):
                    p[secret] = ""
                p.pop("has_" + secret, None)
            if not isinstance(p.get("workflow", {}), dict):
                raise ValueError("ComfyUI workflow must be an API-format JSON object")
        for capability, route in incoming.get("routes", {}).items():
            if capability not in CAPABILITIES:
                raise ValueError("Unknown capability")
            pid = route.get("provider", "")
            if capability == "speech" and pid in ("browser", "edge", "system"):
                continue
            if pid and (pid not in incoming["providers"] or capability not in SUPPORT[incoming["providers"][pid]["kind"]]):
                raise ValueError(f"Provider does not support {capability}")
        if incoming.get("ocr_mode") not in ("auto", "always", "off"):
            raise ValueError("Invalid OCR mode")
        # Keep all task routes when clients send a full settings document.
        if set(incoming.get("routes", {})) != CAPABILITIES:
            raise ValueError("All capability routes must be provided")
        path = settings_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(incoming, indent=2), encoding="utf-8")
        os.replace(tmp, path)
    return public_settings()


def selected(capability):
    data = load()
    route = data["routes"][capability]
    pid = route["provider"]
    if pid in ("browser", "edge", "system") and capability == "speech":
        return {"kind": pid, "name": pid}, route.get("model", "")
    if not pid or pid not in data["providers"]:
        raise ValueError(f"Choose a {capability} provider in Settings first")
    return data["providers"][pid], route.get("model", "")


def request(provider, method, path, **kwargs):
    base = validate_url(provider.get("base_url", ""))
    headers = dict(kwargs.pop("headers", {}))
    if provider.get("api_key"):
        headers["Authorization"] = "Bearer " + provider["api_key"]
    # No requests-level logging or response dumps: upstream messages may echo secrets.
    try:
        with requests.Session() as session:
            if urlparse(base).hostname in ("127.0.0.1", "localhost", "::1"):
                session.trust_env = False
            response = session.request(method, base + path, headers=headers, timeout=kwargs.pop("timeout", (10, 180)), **kwargs)
    except requests.RequestException:
        raise ValueError(f"Cannot reach {provider.get('name', 'provider')}. Check its URL and service.") from None
    if not response.ok:
        raise ValueError(f"{provider.get('name', 'Provider')} returned HTTP {response.status_code}. Check credentials, model, quota and capability.")
    return response


def discover(pid, capability="text", override=None):
    p = copy.deepcopy(load()["providers"][pid])
    if override:
        p.update({k: v for k, v in override.items() if k in ("base_url", "api_key") and v})
    kind = p["kind"]
    if kind == "ollama":
        data = request(p, "GET", "/api/tags", timeout=8).json()
        models = [{"id": m["name"], "size": m.get("size")} for m in data.get("models", [])]
    elif kind == "automatic1111":
        models = [{"id": m["title"]} for m in request(p, "GET", "/sdapi/v1/sd-models", timeout=8).json()]
    elif kind == "comfyui":
        nodes = request(p, "GET", "/object_info", timeout=15).json()
        names = nodes.get("CheckpointLoaderSimple", {}).get("input", {}).get("required", {}).get("ckpt_name", [[]])[0]
        models = [{"id": n} for n in names]
    elif kind in ("openrouter", "compatible", "unlimited_ocr"):
        suffix = "/videos/models" if kind == "openrouter" and capability == "video" else "/images/models" if kind == "openrouter" and capability == "image" else "/models"
        models = request(p, "GET", suffix, timeout=15).json().get("data", [])
    elif kind == "gemini":
        from google import genai
        try:
            models = [{"id": m.name.removeprefix("models/")} for m in genai.Client(api_key=p.get("api_key")).models.list()]
        except Exception:
            raise ValueError("Gemini discovery failed. Check API key and connectivity.") from None
    else:
        raise ValueError("Baidu OCR uses its OCR API rather than a model catalogue")
    return {"ok": True, "models": models, "capabilities": sorted(SUPPORT[kind])}


def chat(prompt, system=None, json_mode=False, image=None, mime="image/png"):
    p, model = selected("vision" if image is not None else "text")
    kind = p["kind"]
    if not model:
        raise ValueError("Choose a model in Settings")
    if kind == "ollama":
        import ollama
        messages = ([{"role": "system", "content": system}] if system else [])
        user = {"role": "user", "content": prompt}
        if image is not None:
            user["images"] = [image]
        messages.append(user)
        return ollama.Client(host=p["base_url"], timeout=180).chat(model=model, messages=messages,
                format="json" if json_mode else None, options={"num_ctx": config.OLLAMA_NUM_CTX})["message"]["content"]
    if kind == "gemini":
        from google import genai
        from google.genai import types
        contents = [types.Part.from_bytes(data=image, mime_type=mime), prompt] if image is not None else prompt
        response = genai.Client(api_key=p.get("api_key")).models.generate_content(model=model, contents=contents,
            config=types.GenerateContentConfig(system_instruction=system, response_mime_type="application/json" if json_mode else None))
        if not response.text:
            raise ValueError("Provider returned no text")
        return response.text
    content = prompt if image is None else [{"type": "text", "text": prompt},
        {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{base64.b64encode(image).decode()}"}}]
    body = {"model": model, "messages": ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": content}]}
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    result = request(p, "POST", "/chat/completions", json=body).json()
    return result["choices"][0]["message"]["content"]


def embedding(text):
    p, model = selected("embedding")
    if not model:
        raise ValueError("Choose an embedding model in Settings")
    if p["kind"] == "ollama":
        import ollama
        return ollama.Client(host=p["base_url"], timeout=120).embed(model=model, input=text).embeddings[0]
    return request(p, "POST", "/embeddings", json={"model": model, "input": text}).json()["data"][0]["embedding"]
