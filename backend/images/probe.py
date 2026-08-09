"""Read an image's pixel size straight out of its header.

Pillow is not a dependency and is not worth adding for two integers that only
label a card. Unknown formats return ``(0, 0)`` and the caller falls back to the
size it asked for.
"""

from __future__ import annotations

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
# Start-of-frame markers carry the dimensions; DHT/DAC/RST/SOS never do.
_JPEG_SOF = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}


def probe_size(data: bytes) -> tuple[int, int]:
    """Return ``(width, height)`` for PNG/JPEG bytes, or ``(0, 0)``."""
    if data[:8] == _PNG_SIGNATURE and len(data) >= 24:
        return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
    if data[:2] == b"\xff\xd8":
        return _jpeg_size(data)
    return 0, 0


def _jpeg_size(data: bytes) -> tuple[int, int]:
    """Walk the JPEG segment chain to the first start-of-frame marker."""
    i = 2
    end = len(data)
    while i + 9 < end:
        if data[i] != 0xFF:
            i += 1  # resync: padding bytes between segments are legal
            continue
        marker = data[i + 1]
        if marker in _JPEG_SOF:
            return (
                int.from_bytes(data[i + 7 : i + 9], "big"),
                int.from_bytes(data[i + 5 : i + 7], "big"),
            )
        seg_len = int.from_bytes(data[i + 2 : i + 4], "big")
        if seg_len < 2:
            break
        i += 2 + seg_len
    return 0, 0


def mime_for(data: bytes) -> str:
    """Best-effort content type, defaulting to PNG."""
    if data[:8] == _PNG_SIGNATURE:
        return "image/png"
    if data[:2] == b"\xff\xd8":
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return "image/png"
