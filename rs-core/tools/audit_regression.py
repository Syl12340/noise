"""Independently inspect preserved regression logs; do not execute suites."""
from pathlib import Path
import json

root = Path(__file__).resolve().parents[1]
reports = root / 'reports'
baseline = root / '_work/baseline/docs/scientific-repairs-2026-10-05'
def head(path):
    return json.loads(path.read_text(encoding='utf-8').splitlines()[0])

checks = []
counts = {'rc-repairs':27, 'recorder-usability':26, 'scientific-followup':22,
          'scientific-repairs':17, 'revision-regression':46, 'paper-engineering-repairs':14}
for name, count in counts.items():
    data = head(reports / f'regression-{name}.log')
    checks.append({'name':name, 'pass':data['passed']==count and data['failed']==0, 'actual':data})
for name in ['formant-validation', 'formant-holdout']:
    actual = head(reports / f'regression-{name}.log')
    expected = head(baseline / f'{name}.log')
    checks.append({'name':name, 'pass':actual==expected, 'aggregateMatches':actual.get('aggregate')==expected.get('aggregate')})
lines = (reports/'regression-algorithm-evaluation.log').read_text(encoding='utf-8').splitlines()
summary, failure = json.loads(lines[0]), json.loads(lines[1])
checks.append({'name':'algorithm-evaluation','pass':summary.get('total')==83 and summary.get('passed')==82 and summary.get('failed')==1 and summary.get('errors')==0 and failure.get('name')=='Vowel pipeline F0=400 Hz', 'actual':summary,'knownFailure':failure.get('name')})
result = {'status':'PASS' if all(c['pass'] for c in checks) else 'FAIL', 'checks':checks,
          'scope':'Preserved Node baseline logs; not Rust parity, real-device or clinical validation'}
(reports/'regression-independent-audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n', encoding='utf-8')
print(json.dumps(result,ensure_ascii=False))
raise SystemExit(0 if result['status']=='PASS' else 1)
