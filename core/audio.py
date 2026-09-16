"""Natural-sounding read-aloud via edge-tts: free, no API key, uses the same
neural voices as Microsoft Edge's "Read aloud" / Windows Narrator -- much
less robotic than offline SAPI voices (pyttsx3) or most free TTS libraries.
Requires internet (it calls Microsoft's service), but needs no signup or key.
"""

import asyncio
import hashlib
import json
from pathlib import Path

import edge_tts

from core import config

AUDIO_DIR = config.DATA_DIR / "audio_cache"
AUDIO_DIR.mkdir(exist_ok=True)

VOICES = {
    "Aria (US, warm)": "en-US-AriaNeural",
    "Guy (US, calm)": "en-US-GuyNeural",
    "Jenny (US, friendly)": "en-US-JennyNeural",
    "Sonia (UK)": "en-GB-SoniaNeural",
}
DEFAULT_VOICE = "Aria (US, warm)"


def _cache_path(text: str, voice: str) -> Path:
    key = hashlib.sha1(f"{voice}::{text}".encode("utf-8")).hexdigest()[:24]
    return AUDIO_DIR / f"{key}.mp3"


def synthesize(text: str, voice_label: str = DEFAULT_VOICE) -> str:
    """Return a path to an MP3 for this text+voice, generating (and caching)
    it if needed. Cheap to call repeatedly -- identical text/voice reuses
    the cached file instead of re-synthesizing."""
    voice = VOICES.get(voice_label, VOICES[DEFAULT_VOICE])
    path = _cache_path(text, voice)
    if not path.exists():
        async def _run():
            communicate = edge_tts.Communicate(text, voice)
            await communicate.save(str(path))

        asyncio.run(_run())
    return str(path)


async def _synthesize_with_sentence_offsets(text: str, voice: str, out_path: Path) -> list[dict]:
    """Write the mp3 to out_path while capturing edge-tts's SentenceBoundary
    events, then map each one back to a character offset in `text` by
    sequential substring search (each sentence is searched for starting from
    where the previous match ended, so repeated sentences still line up in
    order). Best-effort: a sentence that can't be located (rare -- edge-tts
    occasionally normalizes punctuation/whitespace) just yields no marker for
    that boundary instead of failing the whole synthesis."""
    communicate = edge_tts.Communicate(text, voice, boundary="SentenceBoundary")
    boundary_markers = []
    cursor = 0
    with open(out_path, "wb") as f:
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                f.write(chunk["data"])
            elif chunk["type"] == "SentenceBoundary":
                sentence = chunk.get("text", "")
                if not sentence:
                    continue
                idx = text.find(sentence, cursor)
                if idx == -1:
                    continue
                boundary_markers.append({"char_offset": idx, "seconds": chunk["offset"] / 10_000_000})
                cursor = idx + len(sentence)
    return boundary_markers


def _nearest_marker_seconds(boundary_markers: list[dict], char_offset: int) -> float:
    at_or_after = [m for m in boundary_markers if m["char_offset"] >= char_offset]
    if at_or_after:
        return min(at_or_after, key=lambda m: m["char_offset"])["seconds"]
    return boundary_markers[-1]["seconds"] if boundary_markers else 0.0


def synthesize_full_script(text: str, section_markers: list[dict], voice_label: str = DEFAULT_VOICE) -> dict:
    """Synthesize a whole paper's read-aloud script as one cached mp3, and
    resolve each of `section_markers` (from pipeline.build_full_audio_script,
    [{"section_name","char_offset"}]) to a real audio-time offset so the
    player can jump straight to a section. Section-jump markers are
    best-effort (see _synthesize_with_sentence_offsets) -- if sentence
    matching fails entirely, the audio still plays fine, just without jump
    points."""
    voice = VOICES.get(voice_label, VOICES[DEFAULT_VOICE])
    path = _cache_path(text, voice)
    manifest_path = path.with_suffix(".markers.json")

    if path.exists() and manifest_path.exists():
        return {"path": str(path), "markers": json.loads(manifest_path.read_text())}

    boundary_markers = asyncio.run(_synthesize_with_sentence_offsets(text, voice, path))
    section_times = [
        {"section_name": sm["section_name"], "seconds": _nearest_marker_seconds(boundary_markers, sm["char_offset"])}
        for sm in section_markers
    ]
    manifest_path.write_text(json.dumps(section_times))
    return {"path": str(path), "markers": section_times}
