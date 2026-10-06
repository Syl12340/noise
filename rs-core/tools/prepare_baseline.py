"""Export only relevant committed files for read-only Phase 0 analysis."""
from pathlib import Path
import hashlib
import json
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[2]
BASELINE = '3a0d6765147c56d2a73e1cec78f6106ae2e681ab'
WORK = ROOT / 'rs-core/_work'
SOURCE = WORK / 'baseline'
WORK.mkdir(parents=True, exist_ok=True)
SOURCE.mkdir(exist_ok=True)
for folder in ['phase0', 'reports']:
    (ROOT / 'rs-core' / folder).mkdir(exist_ok=True)
archive = WORK / 'baseline.zip'
with archive.open('wb') as output:
    subprocess.run(['git','archive','--format=zip',BASELINE,'app.js','app.json','app.wxss',
                    'project.config.json','pages','utils','workers','tests','scripts','images',
                    'docs/engineering-repairs-2026-10-05.md',
                    'docs/scientific-repairs-2026-10-05'],cwd=ROOT,stdout=output,check=True)
with zipfile.ZipFile(archive) as files:
    for entry in files.infolist():
        target = (SOURCE / entry.filename).resolve()
        if not target.is_relative_to(SOURCE.resolve()):
            raise ValueError('Archive path outside isolated baseline')
    for entry in files.infolist():
        target = SOURCE / entry.filename
        if entry.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        payload = files.read(entry)
        if target.exists():
            if target.read_bytes() != payload:
                raise ValueError('Existing baseline file differs; do not overwrite: '+entry.filename)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload)
manifest = {'baselineCommit':BASELINE,'source':'git archive; committed blobs, no private config or untracked files',
            'files':{p.relative_to(SOURCE).as_posix():hashlib.sha256(p.read_bytes()).hexdigest()
                     for p in sorted(SOURCE.rglob('*')) if p.is_file()}}
(ROOT/'rs-core/phase0/BASELINE_SOURCE_MANIFEST.json').write_text(
    json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'baseline':BASELINE,'directory':str(SOURCE),'files':len(manifest['files'])},ensure_ascii=False))
