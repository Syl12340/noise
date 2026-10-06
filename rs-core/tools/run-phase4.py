"""Full independent HNR verification, including all preceding port regressions."""
from pathlib import Path
import datetime,hashlib,json,subprocess,sys
root=Path(__file__).resolve().parents[1]
clean=['--repository-clean'] if '--repository-clean' in sys.argv else []
commands=[
    ['python','tools/run-phase3.py']+clean,
    ['cargo','test','--workspace','--features','noise-wasm/harmonicity','--locked','--offline'],
    ['cargo','build','-p','noise-wasm','--features','harmonicity','--example','harmonicity_driver','--release','--locked','--offline'],
    ['python','tools/compare_hnr.py'],
    ['python','tools/check_hnr_freeze.py'],
    ['cargo','build','-p','noise-wasm','--features','harmonicity','--target','wasm32-unknown-unknown','--release','--locked','--offline'],
    ['node','phase4/check-hnr-wasm.cjs'],
    ['node','phase3/check-speech-wasm.cjs','--harmonicity'],
    ['node','phase2/check-noise-host.cjs','--harmonicity'],
    ['python','tools/compare_p0_native.py','--wasm','--harmonicity'],
    ['cargo','fmt','--all','--','--check'],
    ['cargo','clippy','--workspace','--all-targets','--features','noise-wasm/harmonicity','--locked','--offline','--','-D','warnings'],
    ['python','tools/check_port_isolation.py']+clean,
]
report={'status':'RUNNING','startedUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'commands':[],'repositoryCleanMode':bool(clean)}
destination=root/'reports/phase4-verification.json'
for command in commands:
    print('RUN '+' '.join(command),flush=True);start=datetime.datetime.now(datetime.timezone.utc)
    run=subprocess.run(command,cwd=root,capture_output=True,text=True,encoding='utf8',errors='replace',timeout=300)
    report['commands'].append({'command':command,'exitCode':run.returncode,'elapsedSeconds':(datetime.datetime.now(datetime.timezone.utc)-start).total_seconds(),'stdout':run.stdout,'stderr':run.stderr})
    print('PASS' if run.returncode==0 else 'FAIL',flush=True)
    if run.returncode:report['status']='FAIL';destination.write_bytes((json.dumps(report,indent=2)+'\n').encode('utf8'));print(run.stdout+run.stderr);sys.exit(1)
report['status']='PASS_DESKTOP_COMPATIBILITY_ONLY';report['finishedUtc']=datetime.datetime.now(datetime.timezone.utc).isoformat();report['identities']={}
for folder in ('crates','phase4','tools','coefficients/hnr-v1'):
    for p in sorted((root/folder).rglob('*')):
        if p.is_file() and '__pycache__' not in str(p) and p.suffix in ('.rs','.py','.cjs','.toml','.md','.f64le'):
            report['identities'][p.relative_to(root).as_posix()]=hashlib.sha256(p.read_bytes()).hexdigest()
report['limits']=['HNR single WASM input max8192, no full5s session/Worker scheduler','Native validation uses frozen JS-sin oracle, no native libm qualification','No production integration or realWX/device/clinical validation','LPC/formants and full phonetic pipeline remain open']
destination.write_bytes((json.dumps(report,indent=2)+'\n').encode('utf8'));print(json.dumps({'status':report['status'],'topLevelCommandsPassed':len(commands),'previousStageChecks':28}))
