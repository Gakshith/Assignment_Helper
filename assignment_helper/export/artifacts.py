"""The scan-artifact pass. Our own transforms, Pillow only.

I17 — and this module is the reason it is worth stating twice: `cv2`, `skimage`,
`skan`, `numba` and `numpy` may be imported only inside function bodies under
`assignment_helper/glyphs/**`. `export/` is not `glyphs/`, so this module may not import
them AT ALL, not even lazily. An import-linter contract in pyproject.toml enforces it and
gate G13b measures the launch cost it protects.

That constraint is not a hardship. Pillow does perspective transform, blur and
per-channel adjustment perfectly well; the only thing numpy would have bought is the 8x8
solve for the perspective coefficients, which is thirty lines of Gaussian elimination
below.

Two dependencies deliberately NOT used:
  * `augraphy` — optional, pinned, behind a flag. Per the fallback doctrine it is
    droppable rather than load-bearing, so nothing here calls it and M1 ships without it.
  * `scan-simulator` — DOES NOT EXIST on PyPI. An earlier research pass hallucinated it.
    Do not try to install it.

Everything here is deterministic in `seed`: the same document exports to the same bytes.
"""

from __future__ import annotations

import random
from dataclasses import dataclass

from PIL import Image, ImageChops, ImageFilter

__all__ = ["ArtifactParams", "apply_artifacts", "perspective_coefficients"]


@dataclass(frozen=True)
class ArtifactParams:
    """How hard the pass leans on each transform. 0 disables one outright.

    The defaults are tuned for "photographed off a desk under a window", not for
    "obviously filtered". G10 pulls the other way on exactly these knobs and G10 is a
    warning, not a gate: believability wins.
    """

    # Largest corner displacement, as a fraction of the page's short side.
    perspective: float = 0.0035
    # Peak darkening at the page corners, 0..1.
    vignette: float = 0.16
    # Peak darkening in the shadow band along one edge, 0..1.
    edge_shadow: float = 0.16
    # Width of that band, as a fraction of the page width.
    edge_shadow_width: float = 0.07
    # Warmth added to red and taken from blue, in 0..255 units at midtone.
    tint: float = 6.0
    # Gaussian radius in pixels at 200 DPI, scaled with the real DPI.
    softness: float = 0.4


def perspective_coefficients(
    dest: list[tuple[float, float]], src: list[tuple[float, float]]
) -> tuple[float, ...]:
    """The 8 coefficients Pillow's `Image.PERSPECTIVE` wants.

    Pillow maps OUTPUT pixels back to INPUT pixels:

        x_in = (a*x_out + b*y_out + c) / (g*x_out + h*y_out + 1)
        y_in = (d*x_out + e*y_out + f) / (g*x_out + h*y_out + 1)

    so `dest` is the output quad and `src` the input quad it should sample from. Solved
    with Gaussian elimination and partial pivoting because numpy is forbidden here (I17),
    not because scipy would be nicer.
    """
    if len(dest) != 4 or len(src) != 4:
        raise ValueError(
            f"perspective needs exactly 4 corners on each side, got {len(dest)} and {len(src)}"
        )

    matrix: list[list[float]] = []
    rhs: list[float] = []
    for (xo, yo), (xi, yi) in zip(dest, src, strict=True):
        matrix.append([xo, yo, 1, 0, 0, 0, -xi * xo, -xi * yo])
        rhs.append(xi)
        matrix.append([0, 0, 0, xo, yo, 1, -yi * xo, -yi * yo])
        rhs.append(yi)

    return tuple(_solve(matrix, rhs))


def _solve(a: list[list[float]], b: list[float]) -> list[float]:
    """Dense linear solve, partial pivoting. n is always 8 here."""
    n = len(b)
    m = [[*row[:], b[i]] for i, row in enumerate(a)]

    for col in range(n):
        pivot = max(range(col, n), key=lambda r: abs(m[r][col]))
        if abs(m[pivot][col]) < 1e-12:
            # Never silent (I5): a degenerate quad is a bug in the caller, and saying
            # "the corners are collinear" is the whole diagnosis.
            raise ValueError(
                "perspective corners are degenerate (collinear or coincident); "
                f"column {col} has no usable pivot"
            )
        m[col], m[pivot] = m[pivot], m[col]

        inv = 1.0 / m[col][col]
        for j in range(col, n + 1):
            m[col][j] *= inv

        for r in range(n):
            if r == col:
                continue
            factor = m[r][col]
            if factor == 0.0:
                continue
            for j in range(col, n + 1):
                m[r][j] -= factor * m[col][j]

    return [m[i][n] for i in range(n)]


def _perspective(img: Image.Image, rng: random.Random, params: ArtifactParams) -> Image.Image:
    """A slight off-axis tilt, as if the page were not square to the scanner glass.

    The source quad is pushed INWARD, never outward. Sampling from inside the image
    means no corner of the output can land on undefined pixels, so the page never gains
    a white wedge — the artefact that instantly reads as "filtered" rather than "scanned".
    """
    if params.perspective <= 0:
        return img

    w, h = img.size
    reach = params.perspective * min(w, h)

    def jitter() -> float:
        return rng.uniform(0.25, 1.0) * reach

    src = [
        (jitter(), jitter()),
        (w - jitter(), jitter()),
        (w - jitter(), h - jitter()),
        (jitter(), h - jitter()),
    ]
    dest = [(0.0, 0.0), (float(w), 0.0), (float(w), float(h)), (0.0, float(h))]
    coeffs = perspective_coefficients(dest, src)
    return img.transform((w, h), Image.Transform.PERSPECTIVE, coeffs, Image.Resampling.BICUBIC)


def _gradient_mask(size: tuple[int, int], stops: list[int], horizontal: bool) -> Image.Image:
    """An L-mode ramp built from a handful of stops and stretched to the page.

    Cheap by construction: the ramp is authored at `len(stops)` pixels and resized, so
    the cost does not scale with page area the way a per-pixel loop would.
    """
    w, h = size
    if horizontal:
        strip = Image.new("L", (len(stops), 1))
        strip.putdata(stops)
    else:
        strip = Image.new("L", (1, len(stops)))
        strip.putdata(stops)
    return strip.resize((w, h), Image.Resampling.BILINEAR)


def _vignette(img: Image.Image, params: ArtifactParams) -> Image.Image:
    """Corners a little darker than the middle, the way every phone photo is."""
    if params.vignette <= 0:
        return img

    amount = max(0.0, min(1.0, params.vignette))
    # radial_gradient is black (0) at the centre and white (255) at the rim.
    radial = Image.radial_gradient("L").resize(img.size, Image.Resampling.BILINEAR)
    mask = radial.point(lambda v: 255 - int(v * amount))
    return ImageChops.multiply(img, Image.merge("RGB", (mask, mask, mask)))


def _edge_shadow(img: Image.Image, rng: random.Random, params: ArtifactParams) -> Image.Image:
    """The soft shadow a page casts along the edge nearest the light."""
    if params.edge_shadow <= 0 or params.edge_shadow_width <= 0:
        return img

    amount = max(0.0, min(1.0, params.edge_shadow))
    dark = 255 - int(255 * amount)
    steps = 64
    ramp = [dark + round((255 - dark) * (i / (steps - 1)) ** 0.6) for i in range(steps)]

    horizontal = rng.random() < 0.5
    flip = rng.random() < 0.5
    if flip:
        ramp = list(reversed(ramp))

    width_frac = max(0.01, min(0.5, params.edge_shadow_width))
    # Hold the ramp inside a band and leave the rest of the page untouched.
    band = max(2, int(steps * width_frac / 0.5))
    stops = [255] * (steps - band) + ramp[-band:] if flip else ramp[:band] + [255] * (steps - band)

    mask = _gradient_mask(img.size, stops, horizontal=horizontal)
    return ImageChops.multiply(img, Image.merge("RGB", (mask, mask, mask)))


def _tint(img: Image.Image, params: ArtifactParams) -> Image.Image:
    """Warm the paper and lift the blacks, per channel.

    Scanners never return a neutral grey; cheap ones swing warm and none of them reach
    0 on the black point. Two 256-entry LUTs, applied by Pillow in C.
    """
    if params.tint == 0:
        return img

    t = params.tint
    r, g, b = img.split()

    def warm(v: int) -> int:
        # Strongest at midtone, zero at both ends, so highlights stay paper-white.
        bell = 1.0 - abs(v - 128) / 128.0
        return max(0, min(255, v + int(t * bell)))

    def cool(v: int) -> int:
        bell = 1.0 - abs(v - 128) / 128.0
        return max(0, min(255, v - int(t * bell)))

    return Image.merge("RGB", (r.point(warm), g, b.point(cool)))


def _soften(img: Image.Image, params: ArtifactParams, dpi: int) -> Image.Image:
    """The optical softness of a real capture. Nothing scanned is pixel-sharp."""
    radius = params.softness * (dpi / 200.0)
    if radius <= 0:
        return img
    return img.filter(ImageFilter.GaussianBlur(radius))


def apply_artifacts(
    img: Image.Image,
    *,
    seed: int,
    dpi: int = 200,
    params: ArtifactParams | None = None,
) -> Image.Image:
    """Turn a clean render into something that looks photographed.

    Deterministic in `seed`. Returns an RGB image the same size as the input.
    `--no-artifacts` (invariant I15) does not weaken these parameters — it skips this
    function entirely and ships the clean render, so the bypass is total and visible.
    """
    p = params or ArtifactParams()
    rng = random.Random(seed)

    out = img.convert("RGB") if img.mode != "RGB" else img
    out = _perspective(out, rng, p)
    out = _edge_shadow(out, rng, p)
    out = _vignette(out, p)
    out = _tint(out, p)
    out = _soften(out, p, dpi)
    return out
