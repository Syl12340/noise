"""Archive the initial draft and create provenance for the revised manuscript."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import re
import shutil
import sys

ROOT = Path(__file__).resolve().parents[1]
PAPER = ROOT/'docs/paper-acoustic-algorithms-and-engineering.md'
ORIGINAL = ROOT/'docs/paper-acoustics-engineering-evidence-2026-10-04.json'
ARCHIVE = ROOT/'docs/paper-acoustic-algorithms-and-engineering-2026-10-04.md'
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
old = json.loads(ORIGINAL.read_text(encoding='utf-8'))
if '--archive-only' in sys.argv:
    if ARCHIVE.exists():
        assert sha(ARCHIVE) == old['manuscriptSha256']
    else:
        assert sha(PAPER) == old['manuscriptSha256']
        shutil.copy2(PAPER, ARCHIVE)
    print(str(ARCHIVE))
else:
    text = PAPER.read_text(encoding='utf-8')
    target = ROOT/'docs/paper-acoustics-engineering-evidence-2026-10-05.json'
    for link in re.findall(r'\]\(([^)]+)\)', text):
        if link.startswith(('https://','http://','#')) or link == target.name:
            continue
        assert (PAPER.parent/link).is_file(), link
    assert [int(n) for n in re.findall(r'\\tag\{(\d+)\}', text)] == list(range(1,19))
    assert text.count('$$') % 2 == 0 and text.count('```') % 2 == 0
    assert all(line.rstrip()==line for line in text.splitlines())
    assert sha(ARCHIVE) == old['manuscriptSha256']
    sources = [*old['sourceSha256'], 'utils/phonetic/fractional-correlation.js']
    folder = ROOT/'docs/scientific-repairs-2026-10-05'
    reports = [*old['reportSha256'], *[str(path.relative_to(ROOT)).replace('\\','/') for path in folder.glob('*.json') if path.name != 'run-manifest.json']]
    for name, value in old['reportSha256'].items():
        assert sha(ROOT/name) == value, name
    run = json.loads((folder/'run-manifest.json').read_text(encoding='utf-8'))
    run['currentSourceMatchesExecutedSnapshot'] = all(sha(ROOT/name)==value for name,value in run['sourceSnapshot'].items()
        if name.startswith(('utils/','pages/')))
    assert run['currentSourceMatchesExecutedSnapshot']
    run['harnessSha256'] = {str(path.relative_to(ROOT)).replace('\\','/'):sha(path) for path in
        [ROOT/'tests/reference-formant-grid.cjs', ROOT/'tests/formant-validation.cjs',ROOT/'tests/formant-holdout.cjs',
         ROOT/'tests/praat-comparison.py',ROOT/'tests/paper-engineering-repairs.cjs',ROOT/'tests/paper-engineering-performance.cjs',
         ROOT/'tests/paper-scientific-validation.py',ROOT/'tests/paper-scientific-summary.py',ROOT/'scripts/verify-repair-performance.py']}
    (folder/'run-manifest.json').write_text(json.dumps(run,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    evidence = {'generatedAt':datetime.now(timezone.utc).isoformat(),
        'algorithmVersion':'acoustics-2026-10-05.1','resultSchemaVersion':2,
        'codeSnapshot':'Current uncommitted working tree',
        'sourceSha256':{name:sha(ROOT/name) for name in sources},
        'reportSha256':{name:sha(ROOT/name) for name in reports},
        'runManifestSha256':sha(folder/'run-manifest.json'),
        'manuscriptSha256':sha(PAPER),'initialDraftSha256':sha(ARCHIVE),
        'initialEvidenceSha256':sha(ORIGINAL),
        'documentChecks':{'localLinksExist':True,'equationsNumbered1To18':True,'balancedMathAndFences':True,'noTrailingWhitespace':True},
        'limitations':['No native-device acceptance','No clinical validity','Formant accuracy and coverage remain below frozen gate','HNR deterministic tests do not prove general clinical accuracy']}
    target.write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'sources':len(sources),'reports':len(reports),'currentSourceMatchesExecutedSnapshot':True,'manuscript':str(PAPER)},ensure_ascii=False))
