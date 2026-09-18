"""Which characters the tracing sheet asks for, and what stands in for the rest.

Anything outside the set is handled by `SUBSTITUTIONS` or raises a Problem at layout
time (acceptance row 5 — never a blank, never tofu).

**Greek is in the set, and that is not decoration.** Measured on 2026-09-17 against all
three OFL hands shipped with this project: Caveat has 1 codepoint in the Greek block,
Reenie Beanie 4, Shadows Into Light 0, and none of them has alpha, tau or theta. Plan
§C.2 claimed outline-first "makes any permissively-licensed handwriting font a valid
shipped reference hand, immediately, free" — true for prose, false for maths, which is
the milestone that needs it most. It surfaced the moment a real physics assignment was
rendered and the first expression wanted a tau.

A student's own hand fixes this completely, because they write their own alpha and tau
— but ONLY if this sheet asks for them. Until then the reference hand badges the block
and the maths is visibly incomplete. See docs/decisions.md.

No CV stack here, at module scope or otherwise.
"""

from __future__ import annotations

LOWERCASE = list("abcdefghijklmnopqrstuvwxyz")
UPPERCASE = list("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
DIGITS = list("0123456789")
PUNCTUATION = list(".,;:!?'\"()[]-–—/&@#%*+=<>$_~")

#: The Greek a physics problem set actually uses. Not the whole alphabet: every cell
#: is 8-15 seconds of the student's time, and omicron is indistinguishable from o.
GREEK_LOWER = list("αβγδεθλμνπρστφωψ")
GREEK_UPPER = list("ΓΔΘΛΠΣΦΩ")

#: Operators that appear in worked solutions and that no handwriting font carries.
MATH_SYMBOLS = list("±∓·×÷≈≠≡≤≥∞∝∫∑√∂∈→")

CHARSET: list[str] = (
    LOWERCASE + UPPERCASE + DIGITS + PUNCTUATION + GREEK_LOWER + GREEK_UPPER + MATH_SYMBOLS
)

#: How many times each character is asked for. One repeat per page.
REPEATS = 4

#: The documented nearest-shape substitution for characters the profile will not
#: contain (acceptance row 5). Written into the profile so `GlyphMetricsProvider.
#: substitute` is data, not code, and so the table can grow without a rebuild.
#: A character with NO sensible substitute is deliberately absent: the provider then
#: returns null and the caller raises a Problem rather than drawing something wrong.
SUBSTITUTIONS: dict[str, str] = {
    "‘": "'",  # left single quote
    "’": "'",  # right single quote / apostrophe
    "“": '"',  # left double quote
    "”": '"',  # right double quote
    "′": "'",  # prime
    "−": "-",  # minus sign
    "‐": "-",  # hyphen
    "‑": "-",  # non-breaking hyphen
    " ": " ",  # non-breaking space
    "…": ".",  # ellipsis -> a period; layout repeats it three times
    "·": ".",  # middle dot
    "•": ".",  # bullet
    "«": '"',
    "»": '"',
    "–": "–",  # en dash is IN the charset; listed so the table is explicit
    "—": "—",  # em dash likewise
}


def assert_charset_fits(charset: list[str] | None = None) -> None:
    """Guard the one number that silently breaks the grid if the set is edited.

    A 91st character would be dropped by `cells_for_page`'s slice and the user would
    simply never be asked to write it, which is precisely the kind of quiet hole this
    codebase refuses (I5). Called by the sheet builder and by a unit test.

    Takes the charset explicitly so that checking a custom set does not silently
    validate the global one instead — which would make the guard useless in exactly
    the case it exists for.
    """
    from assignment_helper.glyphs.layout import CELLS_PER_PAGE

    chars = CHARSET if charset is None else charset
    if len(chars) != CELLS_PER_PAGE:
        raise ValueError(
            f"The charset has {len(chars)} characters but a page holds exactly "
            f"{CELLS_PER_PAGE}. Add or remove characters, or change the grid in "
            f"layout.py — do not let the slice drop them silently."
        )
    if len(set(chars)) != len(chars):
        dupes = sorted({c for c in chars if chars.count(c) > 1})
        raise ValueError(f"The charset contains duplicates: {dupes}")


def label_for(ch: str) -> str:
    """What the cell prints to tell the user what to write.

    Quotes, dashes and the space-adjacent characters are ambiguous at 8 pt in blue,
    so the ones that get confused for each other are spelled out.
    """
    named = {
        "'": "apostrophe '",
        '"': 'quote "',
        "-": "hyphen -",
        "–": "en dash –",
        "—": "em dash —",
        ".": "period .",
        ",": "comma ,",
        ":": "colon :",
        ";": "semicolon ;",
    }
    if ch in named:
        return named[ch]
    # Greek and the maths operators are NAMED rather than shown, because the sheet's
    # label font cannot draw them: Pillow's bundled default has no Greek block, so
    # printing the character itself gives the user a tofu box and no idea what to
    # write in that cell. On a sheet they are about to spend an hour filling in, a
    # box that says nothing is worse than a box that says "alpha".
    if ch in GREEK_NAMES:
        return GREEK_NAMES[ch]
    if ch in SYMBOL_NAMES:
        return SYMBOL_NAMES[ch]
    return ch


#: lower-case Greek, by the name a physics student would say out loud.
GREEK_NAMES: dict[str, str] = {
    "\u03b1": "alpha", "\u03b2": "beta", "\u03b3": "gamma", "\u03b4": "delta",
    "\u03b5": "epsilon", "\u03b8": "theta", "\u03bb": "lambda", "\u03bc": "mu",
    "\u03bd": "nu", "\u03c0": "pi", "\u03c1": "rho", "\u03c3": "sigma",
    "\u03c4": "tau", "\u03c6": "phi", "\u03c9": "omega", "\u03c8": "psi",
    "\u0393": "GAMMA", "\u0394": "DELTA", "\u0398": "THETA", "\u039b": "LAMBDA",
    "\u03a0": "PI", "\u03a3": "SIGMA", "\u03a6": "PHI", "\u03a9": "OMEGA",
}

#: Operators, by what they are for rather than by their Unicode name.
SYMBOL_NAMES: dict[str, str] = {
    "\u00b1": "plus-minus", "\u2213": "minus-plus", "\u00b7": "centre dot",
    "\u00d7": "times", "\u00f7": "divide", "\u2248": "approx",
    "\u2260": "not equal", "\u2261": "identical", "\u2264": "<= or equal",
    "\u2265": ">= or equal", "\u221e": "infinity", "\u221d": "proportional",
    "\u222b": "integral", "\u2211": "sum", "\u221a": "root",
    "\u2202": "partial d", "\u2208": "element of", "\u2192": "arrow"
}
