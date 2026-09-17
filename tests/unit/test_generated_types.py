"""The generated TypeScript types are committed and must not drift from the schema.

Plan §3 names this as the third frozen artifact. Without this test the two halves of
the document model diverge silently, and the first symptom is a render that drops a
field.
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_document_dts_is_current():
    result = subprocess.run(
        [sys.executable, str(ROOT / "scripts/gen_types.py"), "--check"],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    assert result.returncode == 0, result.stdout + result.stderr
