"""Puts tests/ on sys.path so `from support...` works regardless of how pytest is invoked."""

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
for candidate in (HERE, HERE.parent):
    if str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))
