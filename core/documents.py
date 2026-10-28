"""Document extraction without a page-count truncation; optional page OCR."""
import base64
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree

from core import providers, pdf_parser


def unlimited_ocr(doc):
    """SGLang multi-page API described by baidu/Unlimited-OCR (October 2026)."""
    p, model = providers.selected("ocr")
    content = []
    for page in doc:
        png = page.get_pixmap(matrix=__import__("pymupdf").Matrix(2, 2)).tobytes("png")
        content.append({"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(png).decode()}})
    content.append({"type": "text", "text": "<PAGE><image>" * len(doc) + "Multi page parsing."})
    body = {"model": model or "Unlimited-OCR-2", "messages": [{"role": "user", "content": content}],
            "max_tokens": 8000 * len(doc), "temperature": 0, "skip_special_tokens": False,
            "images_config": {"crop_mode": True}, "stream": True,
            "custom_params": {"ngram_size": 35, "window_size": 1024, "page_token_id": 128827, "eos_token_id": 1, "max_page_tokens": 20000}}
    if p.get("custom_logit_processor"):
        body["custom_logit_processor"] = p["custom_logit_processor"]
    output = []
    response = providers.request(p, "POST", "/chat/completions", json=body, stream=True, timeout=(10, 6000))
    try:
        for line in response.iter_lines(decode_unicode=True):
            if not line or not line.startswith("data:"):
                continue
            value = line[5:].strip()
            if value == "[DONE]":
                break
            event = __import__("json").loads(value)
            if event.get("error"):
                raise ValueError("Unlimited-OCR server reported an inference error")
            for choice in event.get("choices", []):
                if choice.get("finish_reason") == "length":
                    raise ValueError("Unlimited-OCR exhausted its output budget. Increase server capacity before retrying.")
                output.append(choice.get("delta", {}).get("content") or "")
    finally:
        response.close()
    text = "".join(output)
    # The model emits a page marker per input page; don't accept partial books silently.
    if text.count("<PAGE>") < len(doc):
        raise ValueError("Unlimited-OCR output is missing page markers. Check server truncation and model configuration.")
    page_number = iter(range(1, len(doc) + 1))
    text = re.sub(r"<PAGE>", lambda _: f"\n\n<!-- Page {next(page_number, len(doc))} -->\n\n", text)
    return text


def baidu_ocr(png: bytes):
    p, _ = providers.selected("ocr")
    if p["kind"] != "baidu":
        raise ValueError("Select Baidu OCR in Settings")
    # OAuth credentials go only to the configured Baidu host, not the browser.
    auth = dict(p)
    auth.pop("api_key", None)
    token = providers.request(auth, "POST", "/oauth/2.0/token", params={
        "grant_type": "client_credentials", "client_id": p.get("api_key", ""),
        "client_secret": p.get("secret_key", "")}).json().get("access_token")
    if not token:
        raise ValueError("Baidu authorization failed. Check OCR credentials.")
    data = providers.request(auth, "POST", "/rest/2.0/ocr/v1/accurate_basic",
        params={"access_token": token}, data={"image": base64.b64encode(png).decode(), "detect_direction": "true"}).json()
    if "error_code" in data:
        raise ValueError(f"Baidu OCR failed (code {data['error_code']}). Check quota and OCR service access.")
    return "\n".join(word["words"] for word in data.get("words_result", []))


def extract(path, image_dir=None):
    path = Path(path)
    suffix = path.suffix.lower()
    if suffix in (".md", ".txt"):
        return path.read_text(encoding="utf-8-sig"), {"format": suffix[1:], "pages": None, "ocr_pages": []}
    if suffix == ".docx":
        with zipfile.ZipFile(path) as archive:
            info = archive.getinfo("word/document.xml")
            if info.file_size > 50_000_000:
                raise ValueError("DOCX content is too large")
            root = ElementTree.fromstring(archive.read(info))
        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
        paragraphs = []
        for paragraph in root.findall(".//w:p", ns):
            text = "".join(n.text or "" for n in paragraph.findall(".//w:t", ns))
            style = paragraph.find("w:pPr/w:pStyle", ns)
            heading = style.get("{" + ns["w"] + "}val", "") if style is not None else ""
            if re.match(r"Heading[1-6]$", heading, re.I):
                text = "#" * int(heading[-1]) + " " + text
            if text:
                paragraphs.append(text)
        return "\n\n".join(paragraphs), {"format": "docx", "pages": None, "ocr_pages": [], "note": "DOCX text and headings; embedded images/layout are not preserved."}
    if suffix != ".pdf":
        raise ValueError("Supported formats: PDF, DOCX, Markdown and UTF-8 text. Convert legacy .doc to .docx first.")
    import pymupdf
    settings = providers.load()
    with pymupdf.open(path) as doc:
        if doc.needs_pass:
            raise ValueError("Password-protected PDF: upload an unlocked copy")
        scan_pages = [i for i, page in enumerate(doc) if len(page.get_text().strip()) < 40 and page.get_images()]
        mode = settings.get("ocr_mode", "auto")
        wants_ocr = list(range(len(doc))) if mode == "always" else scan_pages if mode == "auto" else []
        enabled = bool(settings["routes"]["ocr"]["provider"])
        if enabled and wants_ocr and providers.selected("ocr")[0]["kind"] == "unlimited_ocr":
            text = unlimited_ocr(doc)
            return text, {"format": "pdf", "pages": len(doc), "ocr_pages": list(range(1, len(doc) + 1)), "engine": "Unlimited-OCR 2"}
        if wants_ocr and not enabled:
            if scan_pages:
                raise ValueError(f"{len(scan_pages)} page(s) need OCR. Configure Baidu OCR in Settings, or choose OCR off to accept partial text.")
        if enabled and wants_ocr:
            # Extract page by page to keep reading order and make every OCR page explicit.
            parts = []
            for i, page in enumerate(doc):
                if i in wants_ocr:
                    text = baidu_ocr(page.get_pixmap(matrix=pymupdf.Matrix(1.5, 1.5)).tobytes("png"))
                    if not text.strip():
                        raise ValueError(f"OCR returned no text on page {i + 1}; import stopped to avoid silent loss")
                else:
                    text = pdf_parser.pymupdf4llm.to_markdown(doc, pages=[i], write_images=bool(image_dir), image_path=str(image_dir or ""))
                parts.append(f"<!-- Page {i + 1} -->\n\n{text}")
            return "\n\n".join(parts), {"format": "pdf", "pages": len(doc), "ocr_pages": [i + 1 for i in wants_ocr]}
        text = pdf_parser.extract_text(str(path), image_dir=image_dir)
        return text, {"format": "pdf", "pages": len(doc), "ocr_pages": [], "pages_needing_ocr": [i + 1 for i in scan_pages]}


def spoken_text(markdown):
    """Keep source words, remove visual markup and file paths from narration."""
    text = re.sub(r"<!--.*?-->", " ", markdown, flags=re.S)
    text = re.sub(r"!\[([^\]]*)\]\([^)]+\)", lambda m: " Figure: " + m[1] if m[1] else " ", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"^\s*#{1,6}\s*", "", text, flags=re.M)
    text = re.sub(r"^\s*\|?[\s:|-]+\|\s*$", "", text, flags=re.M)
    return text.replace("```", "").replace("**", "").strip()
