"""Compare the same five-second fixture against preserved before/after copies."""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import datetime

ROOT=Path(__file__).resolve().parents[1]
OUTPUT=ROOT/'docs/scientific-repairs-2026-10-05'
original=json.loads((ROOT/'docs/scientific-validation-2026-10-05/run-manifest.json').read_text(encoding='utf-8'))
current=json.loads((OUTPUT/'run-manifest.json').read_text(encoding='utf-8'))
for label,manifest in [('before',original),('after',current)]:
    stage=Path(manifest['isolatedWorkingDirectory'])
    for name,digest in manifest['sourceSnapshot'].items():
        if name.startswith('utils/') or name.startswith('pages/'):
            assert hashlib.sha256((stage/name).read_bytes()).hexdigest()==digest, name
    helper=stage/'tests/paper-engineering-performance.cjs'
    shutil.copy2(ROOT/'tests/paper-engineering-performance.cjs',helper)
    start=datetime.datetime.now(datetime.timezone.utc)
    command=['node','tests/paper-engineering-performance.cjs']
    run=subprocess.run(command,cwd=stage,capture_output=True,text=True,encoding='utf-8',timeout=240)
    (OUTPUT/('performance-'+label+'.log')).write_text(run.stdout+'\nSTDERR:\n'+run.stderr,encoding='utf-8')
    if run.returncode!=0:
        raise RuntimeError(run.stderr)
    shutil.copy2(stage/'docs/paper-engineering-performance-results.json',OUTPUT/('performance-'+label+'.json'))
    print(label,run.stdout.strip(),flush=True)
    current['commands'].append({'command':command,'case':label,'exitCode':run.returncode,
        'seconds':(datetime.datetime.now(datetime.timezone.utc)-start).total_seconds(),'log':'performance-'+label+'.log'})
assert json.loads((OUTPUT/'performance-before.json').read_text())['inputSha256']==json.loads((OUTPUT/'performance-after.json').read_text())['inputSha256']
current['performanceHarnessSha256']=hashlib.sha256((ROOT/'tests/paper-engineering-performance.cjs').read_bytes()).hexdigest()
(OUTPUT/'run-manifest.json').write_text(json.dumps(current,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
