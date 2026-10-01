"""Check that the report is a substantive artifact; its size is the result."""
import json
import os
from pathlib import Path

report = Path("deliverables/report.md")
text = report.read_text(encoding="utf-8")
if len(text.strip()) < 50:
    raise SystemExit("Report must contain substantive text, not an empty artifact")
Path(os.environ["ASYS_RESULT"]).write_text(json.dumps({
    "path": str(report), "bytes": report.stat().st_size
}), encoding="utf-8")
