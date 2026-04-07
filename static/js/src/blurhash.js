// === blurhash.js ===
// Inline Blurhash decoder (~60 lines) — avoids an extra CDN request.
// globals: decodeBlurhash, initBlurhash

const _bhDigits = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-./:;=?@[]^_{|}~';
const _bhLookup = new Uint8Array(128);
for (let i = 0; i < _bhDigits.length; i++) _bhLookup[_bhDigits.charCodeAt(i)] = i;

function _bhDecode83(str, from, to) {
    let v = 0;
    for (let i = from; i < to; i++) v = v * 83 + _bhLookup[str.charCodeAt(i)];
    return v;
}

function _bhSRGBToLinear(v) { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); }
function _bhLinearToSRGB(v) { return Math.max(0, Math.min(255, Math.round(v <= 0.0031308 ? v * 12.92 * 255 : (1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255))); }
function _bhDecodeDC(val) { return [_bhSRGBToLinear(val >> 16), _bhSRGBToLinear((val >> 8) & 255), _bhSRGBToLinear(val & 255)]; }

function _bhDecodeAC(val, maxAC) {
    const qR = Math.floor(val / (19 * 19)), qG = Math.floor(val / 19) % 19, qB = val % 19;
    return [
        Math.sign(qR - 9) * Math.pow((Math.abs(qR - 9)) / 9, 2) * maxAC,
        Math.sign(qG - 9) * Math.pow((Math.abs(qG - 9)) / 9, 2) * maxAC,
        Math.sign(qB - 9) * Math.pow((Math.abs(qB - 9)) / 9, 2) * maxAC,
    ];
}

function decodeBlurhash(hash, w, h) {
    const sizeFlag = _bhDecode83(hash, 0, 1);
    const numX = (sizeFlag % 9) + 1, numY = Math.floor(sizeFlag / 9) + 1;
    const qMaxVal = _bhDecode83(hash, 1, 2);
    const maxAC = (qMaxVal + 1) / 166;
    const colors = [_bhDecodeDC(_bhDecode83(hash, 2, 6))];
    for (let i = 1; i < numX * numY; i++) colors.push(_bhDecodeAC(_bhDecode83(hash, 4 + i * 2, 6 + i * 2), maxAC));
    const pixels = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let r = 0, g = 0, b = 0;
            for (let j = 0; j < numY; j++) {
                for (let i = 0; i < numX; i++) {
                    const basis = Math.cos(Math.PI * x * i / w) * Math.cos(Math.PI * y * j / h);
                    const c = colors[j * numX + i];
                    r += c[0] * basis; g += c[1] * basis; b += c[2] * basis;
                }
            }
            const idx = (y * w + x) * 4;
            pixels[idx] = _bhLinearToSRGB(r); pixels[idx + 1] = _bhLinearToSRGB(g);
            pixels[idx + 2] = _bhLinearToSRGB(b); pixels[idx + 3] = 255;
        }
    }
    return pixels;
}

function initBlurhash(scope) {
    const imgs = (scope || document).querySelectorAll('img[data-blurhash]');
    if (!imgs.length) return;
    imgs.forEach(img => {
        if (img.complete && img.naturalWidth > 0) return;
        if (img.dataset.bhApplied) return;
        const hash = img.dataset.blurhash;
        if (!hash || hash.length < 6) return;
        img.dataset.bhApplied = '1';
        try {
            const pixels = decodeBlurhash(hash, 32, 32);
            const canvas = document.createElement('canvas');
            canvas.width = 32; canvas.height = 32;
            const ctx = canvas.getContext('2d');
            const imageData = ctx.createImageData(32, 32);
            imageData.data.set(pixels);
            ctx.putImageData(imageData, 0, 0);
            img.style.backgroundImage = `url(${canvas.toDataURL()})`;
            img.style.backgroundSize = 'cover';
            img.addEventListener('load', () => { img.style.backgroundImage = ''; }, { once: true });
        } catch (e) { /* invalid hash — skip silently */ }
    });
}
