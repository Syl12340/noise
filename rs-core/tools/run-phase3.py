"""Full reproducible independent port validation, including actual speech WASM."""
from pathlib import Path
import datetime,hashlib,json,subprocess,sys
ROOT=Path(__file__).resolve().parents[1]
clean=['--repository-clean'] if '--repository-clean' in sys.argv else []
commands=[
    ['python','tools/ensure_baseline.py'],
    ['python','tools/run-phase2.py']+clean,
    ['cargo','test','--workspace','--features','noise-wasm/speech','--locked','--offline'],
    ['python','tools/compare_resample.py'],
    ['python','tools/check_resample_freeze.py'],
    ['cargo','build','-p','noise-wasm','--features','speech','--target','wasm32-unknown-unknown','--release','--locked','--offline'],
    ['node','phase3/check-speech-wasm.cjs'],
    ['node','phase2/check-noise-host.cjs'],
    ['python','tools/compare_p0_native.py','--wasm'],
    ['cargo','fmt','--all','--','--check'],
    ['cargo','clippy','--workspace','--all-targets','--features','noise-wasm/speech','--locked','--offline','--','-D','warnings'],
    ['python','tools/check_port_isolation.py']+clean,
]
report={'status':'RUNNING','startedUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'commands':[],'repositoryCleanMode':bool(clean)}
destination=ROOT/'reports/phase3-verification.json'
for command in commands:
    print('RUN '+' '.join(command),flush=True)
    start=datetime.datetime.now(datetime.timezone.utc)
    run=subprocess.run(command,cwd=ROOT,capture_output=True,text=True,encoding='utf8',errors='replace',timeout=240)
    report['commands'].append({'command':command,'exitCode':run.returncode,'elapsedSeconds':(datetime.datetime.now(datetime.timezone.utc)-start).total_seconds(),'stdout':run.stdout,'stderr':run.stderr})
    print('PASS' if run.returncode==0 else 'FAIL',flush=True)
    if run.returncode:
        report['status']='FAIL';destination.write_text(json.dumps(report,indent=2)+'\n',encoding='utf8');print(run.stdout+run.stderr);sys.exit(1)
report['status']='PASS_DESKTOP_COMPATIBILITY_ONLY'
report['finishedUtc']=datetime.datetime.now(datetime.timezone.utc).isoformat()
report['identities']={}
for folder in ('crates','phase3','coefficients/speech-resample-12000-v1','tools'):
    for file in sorted((ROOT/folder).rglob('*')):
        if file.is_file() and '__pycache__' not in str(file) and (file.suffix in ('.rs','.toml','.py','.cjs','.md') or folder.startswith('coefficients')):
            report['identities'][file.relative_to(ROOT).as_posix()]=hashlib.sha256(file.read_bytes()).hexdigest()
report['limits']=['No production integration','No actual WXWebAssembly/Worker/Android recording verification','Seven12kHz resample profiles only','HNR/LPC/formants and whole phonetic analysis not ported','No new scientific validity or clinical release claim']
destination.write_text(json.dumps(report,indent=2)+'\n',encoding='utf8')
print(json.dumps({'status':report['status'],'topLevelCommandsPassed':len(commands),'phase2CommandsPassed':16}))
