import os
import sys
from pathlib import Path

from dotenv import load_dotenv


def _is_frozen() -> bool:
    """True inside a PyInstaller-frozen build (desktop/build_backend.py)."""
    return bool(getattr(sys, "frozen", False)) and hasattr(sys, "_MEIPASS")


if _is_frozen():
    # PyInstaller's bundle root -- where --add-data put our static/ and
    # assets/ folders (onefile: a temp extraction dir; onedir: the folder
    # next to the exe). Read-only-ish and not guaranteed to survive between
    # runs, so it's right for bundled app resources but wrong for user data.
    ROOT_DIR = Path(sys._MEIPASS)
    if sys.platform == "win32":
        _default_data_dir = Path(os.getenv("LOCALAPPDATA") or Path.home()) / "ResearchPal"
    elif sys.platform == "darwin":
        _default_data_dir = Path.home() / "Library" / "Application Support" / "ResearchPal"
    else:
        _default_data_dir = Path.home() / ".researchpal"
else:
    ROOT_DIR = Path(__file__).resolve().parent.parent
    _default_data_dir = ROOT_DIR / "data"

# Overridable so the Electron desktop shell can point storage at a
# user-chosen folder (e.g. a synced drive) via its Settings screen. Default
# is today's dev behavior when running from source, or a per-user AppData
# folder when frozen (an installed app can't assume its own install
# directory -- often under Program Files -- is writable without admin rights).
DATA_DIR = Path(os.getenv("OCE_DATA_DIR", "")).expanduser() if os.getenv("OCE_DATA_DIR") else _default_data_dir
DATA_DIR.mkdir(parents=True, exist_ok=True)

# .env lives next to the writable data when frozen (always writable, and
# survives app updates/reinstalls since it's outside the install directory);
# next to the source tree in dev, matching today's behavior exactly. Passing
# an explicit path (rather than dotenv's default upward cwd search) means
# this resolves the same way regardless of what directory the process was
# launched from -- important once Electron is the one spawning it.
ENV_PATH = (DATA_DIR / ".env") if _is_frozen() else (ROOT_DIR / ".env")
load_dotenv(dotenv_path=ENV_PATH)

PAPERS_DIR = DATA_DIR / "papers"
DB_PATH = DATA_DIR / "app.db"
PAPERS_DIR.mkdir(exist_ok=True)

PRIMARY_LLM = os.getenv("PRIMARY_LLM", "gemini").lower()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.6-flash")

OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "gemma4")
# Snip-to-ask (image) questions need a vision-capable local model; defaults to
# the text model, which is fine if that model is multimodal.
OLLAMA_VISION_MODEL = os.getenv("OLLAMA_VISION_MODEL") or OLLAMA_MODEL
OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://localhost:11434")
OLLAMA_EMBED_MODEL = os.getenv("OLLAMA_EMBED_MODEL", "nomic-embed-text-v2-moe")
# Ollama defaults to a small context window (often 2048-4096 tokens)
# regardless of what the model architecturally supports, silently dropping
# anything beyond it. 8192 covers our largest prompts (a full paper section
# batch) with room to spare, at a manageable extra RAM cost for the KV cache
# -- raise it (env var) only if you have RAM to spare and need more room.
OLLAMA_NUM_CTX = int(os.getenv("OLLAMA_NUM_CTX", "8192"))
