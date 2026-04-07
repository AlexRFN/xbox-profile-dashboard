import io
import logging

import blurhash
from PIL import Image

log = logging.getLogger("xbox.blurhash")


def encode_from_bytes(image_bytes: bytes, x_components: int = 4, y_components: int = 3) -> str | None:
    """Encode image bytes to a blurhash string."""
    try:
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB").resize((32, 32), Image.LANCZOS)
        # blurhash.encode accepts any row-major 2D sequence of (R, G, B) values.
        # Reshape the flat pixel list into 32 rows — no numpy required.
        flat = list(img.getdata())
        pixels = [flat[y * 32 : (y + 1) * 32] for y in range(32)]
        return blurhash.encode(pixels, x_components, y_components)
    except Exception as e:
        log.warning("Blurhash encode failed: %s", e)
        return None
