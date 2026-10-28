"""Discover Ollama storage by its manifests/blobs structure, never model filenames."""
import os
import time
from collections import deque
from pathlib import Path

SKIP = {"node_modules", ".git", ".venv", "venv", "$recycle.bin", "system volume information", "windows", "__pycache__", "site-packages"}


def environment_folder():
    # A long-running desktop process can have an old environment; read the current user setting.
    if os.name == "nt":
        import winreg
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
                value, _ = winreg.QueryValueEx(key, "OLLAMA_MODELS")
                return os.path.expandvars(value)
        except OSError:
            pass
    return os.getenv("OLLAMA_MODELS", "")


def catalogue(folder):
    models = []
    manifests = folder / "manifests"
    try:
        for path in manifests.rglob("*"):
            if path.is_file():
                parts = path.relative_to(manifests).parts
                if len(parts) >= 3:
                    # registry / namespace / model / tag, retaining non-library namespaces.
                    name = "/".join(parts[1:-1])
                    if name.startswith("library/"):
                        name = name[len("library/"):]
                    models.append(name + ":" + parts[-1])
                if len(models) >= 2000:
                    break
    except OSError:
        pass
    return sorted(set(models))


def discover(root=None, configured=None, seconds=12, max_directories=20000):
    candidates = [configured, environment_folder(), str(Path.home() / ".ollama" / "models")]
    found, seen = [], set()
    def check(path):
        if (path / "manifests").is_dir() and (path / "blobs").is_dir():
            resolved = str(path.resolve())
            if not any(item["path"] == resolved for item in found):
                found.append({"path": resolved, "models": catalogue(path)})
            return True
        return False
    for candidate in candidates:
        if candidate:
            check(Path(candidate).expanduser())
    roots = [Path(root).expanduser()] if root else []
    if not roots:
        for candidate in candidates[:2]:
            if candidate and Path(candidate).anchor:
                roots.append(Path(Path(candidate).anchor))
    if any(not path.is_absolute() or not path.is_dir() for path in roots):
        raise ValueError("Choose an existing absolute search folder or drive root")
    queue = deque((path, 0) for path in roots)
    deadline, scanned = time.monotonic() + seconds, 0
    while queue and scanned < max_directories and time.monotonic() < deadline:
        path, depth = queue.popleft()
        marker = str(path).lower()
        if marker in seen:
            continue
        seen.add(marker)
        scanned += 1
        if check(path):
            continue
        if depth >= 9:
            continue
        try:
            with os.scandir(path) as entries:
                children = [Path(entry.path) for entry in entries if entry.name.lower() not in SKIP and entry.is_dir(follow_symlinks=False)]
            # Prefer likely locations but also inspect renamed/nested storage folders.
            children.sort(key=lambda child: (not any(word in child.name.lower() for word in ("ollama", "model", "install", "software", "ai")), child.name.lower()))
            queue.extend((child, depth + 1) for child in children)
        except (OSError, PermissionError):
            continue
    return {"folders": found, "scanned_directories": scanned, "incomplete": bool(queue),
            "environment_folder": environment_folder(), "environment_folder_exists": bool(environment_folder() and Path(environment_folder()).is_dir())}
