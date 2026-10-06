"""Reproducible isolated verification. Does not export/alter frozen references."""
from pathlib import Path
import datetime
import hashlib
import json
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[1]
repository_clean='--repository-clean' in sys.argv
commands=[
    ['python','tools/check_port_isolation.py'],
    ['cargo','test','--workspace','--features','noise-core/speech,noise-wasm/acoustics','--locked','--offline'],
    ['cargo','build','-p','noise-core','--features','speech','--example','speech_driver','--release','--locked','--offline'],
    ['python','tools/compare_pitch.py'],
    ['cargo','build','-p','noise-core','--features','acoustics','--example','acoustics_driver','--release','--locked','--offline'],
    ['node','phase1/compare-acoustics.cjs'],
    ['cargo','build','-p','noise-wasm','--features','acoustics','--target','wasm32-unknown-unknown','--release','--locked','--offline'],
    ['node','phase2/check-noise-host.cjs'],
    ['python','tools/compare_p0_native.py','--wasm'],
    ['cargo','test','--workspace','--locked','--offline'],
    ['cargo','build','-p','noise-wasm','--target','wasm32v1-none','--release','--locked','--offline'],
    ['node','phase0a/check-wasm.cjs','--json'],
    ['node','phase0a/audit-wx-shape.cjs'],
    ['cargo','fmt','--all','--','--check'],
    ['cargo','clippy','--workspace','--all-targets','--features','noise-core/speech,noise-wasm/acoustics','--locked','--offline','--','-D','warnings'],
    ['python','tools/check_port_isolation.py'],
]
if repository_clean:
    for command in commands:
        if command[:2] in (['python','tools/check_port_isolation.py'],['node','phase1/compare-acoustics.cjs']):
            command.append('--repository-clean')
report={'startedUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'RUNNING','commands':[]}
destination=ROOT/'reports/phase2-verification.json'
for command in commands:
    print('RUN '+' '.join(command),flush=True)
    start=datetime.datetime.now(datetime.timezone.utc)
    run=subprocess.run(command,cwd=ROOT,capture_output=True,text=True,encoding='utf8',errors='replace',timeout=180)
    row={'command':command,'exitCode':run.returncode,'elapsedSeconds':(datetime.datetime.now(datetime.timezone.utc)-start).total_seconds(),'stdout':run.stdout,'stderr':run.stderr}
    report['commands'].append(row)
    print('PASS' if run.returncode==0 else 'FAIL',flush=True)
    if run.returncode:
        print(run.stdout+run.stderr)
        report['status']='FAIL'
        destination.write_text(json.dumps(report,indent=2)+'\n',encoding='utf8')
        sys.exit(1)
report['status']='PASS_DESKTOP_COMPATIBILITY_ONLY'
report['finishedUtc']=datetime.datetime.now(datetime.timezone.utc).isoformat()
report['identities']={}
for p in sorted((ROOT/'crates').rglob('*.rs')):
    report['identities'][str(p.relative_to(ROOT)).replace('\\','/')]=hashlib.sha256(p.read_bytes()).hexdigest()
for folder in ['phase2','tools']:
    for p in sorted((ROOT/folder).glob('*')):
        if p.is_file() and p.suffix in ('.py','.cjs','.md'):
            report['identities'][str(p.relative_to(ROOT)).replace('\\','/')]=hashlib.sha256(p.read_bytes()).hexdigest()
report['limits']=['No production integration','No actual WXWebAssembly or Worker/device recording test','No full speech pipeline/HNR/formant migration or new scientific validation','No 600-second stress or mobile latency guarantee']
destination.write_text(json.dumps(report,indent=2)+'\n',encoding='utf8')
print(json.dumps({'status':report['status'],'commandsPassed':len(report['commands'])}))
