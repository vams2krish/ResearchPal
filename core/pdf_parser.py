from pathlib import Path

import pymupdf4llm


def extract_text(pdf_path: str, image_dir: str | Path | None = None) -> str:
    """Extract markdown text from a PDF: headings (for anatomy detection),
    tables (auto-rendered as markdown pipe tables), monospace/code blocks
    (auto-wrapped in fenced code blocks), and, if image_dir is given, figures
    saved to disk with markdown image references -- all without a paid
    OCR/vision service.
    """
    if image_dir:
        Path(image_dir).mkdir(parents=True, exist_ok=True)
        return pymupdf4llm.to_markdown(
            pdf_path, write_images=True, image_path=str(image_dir), image_format="png"
        )
    return pymupdf4llm.to_markdown(pdf_path)
