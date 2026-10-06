import json
from pathlib import Path
root=Path(__file__).resolve().parents[1]
reasons=set()
for p in (root/'phase0/fixtures').glob('fix*/chunks.json'):
    for ch in json.loads(p.read_text(encoding='utf8')):
        if ch.get('invalidReason'): reasons.add(ch['invalidReason'])
print(json.dumps(sorted(reasons),ensure_ascii=True))
