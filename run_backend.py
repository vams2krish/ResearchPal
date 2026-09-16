"""Standalone entry point for the frozen backend (PyInstaller target) --
`server.py` is normally run via `uvicorn server:app`, which has nothing to
launch when there's no Python interpreter on the target machine to run that
command. This script is what desktop/main.js spawns instead once packaged.

Also runnable directly in dev (`python run_backend.py`) as an equivalent to
`uvicorn server:app --port 8501`.
"""

import os

import uvicorn

from server import app

if __name__ == "__main__":
    port = int(os.environ.get("OCE_PORT", "8501"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
