"""Continuous full-HNR session validation plus all preceding regressions."""
from pathlib import Path
import datetime,hashlib,json,subprocess,sys
root=Path(__file__).resolve().parents[1];clean=['--repository-clean'] if '--repository-clean' in sys.argv else []
commands=[
    ['python','tools/run-phase4.py']+clean,
    ['python','tools/compare_hnr_full.py'],
    ['python','tools/check_hnr_full_freeze.py'],
    ['node','phase5/check-hnr-full.cjs'],
    ['cargo','fmt','--all','--','--check'],
    ['cargo','clippy','--workspace','--all-targets','--features','noise-wasm/harmonicity','--locked','--offline','--','-D','warnings'],
    ['python','tools/check_port_isolation.py']+clean,
]
report={'status':'RUNNING','startedUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'commands':[],'repositoryCleanMode':bool(clean)}
destination=root/'reports/phase5-verification.json'
for command in commands:
    print('RUN '+' '.join(command),flush=True);start=datetime.datetime.now(datetime.timezone.utc)
    run=subprocess.run(command,cwd=root,capture_output=True,text=True,encoding='utf8',errors='replace',timeout=300)
    report['commands'].append({'command':command,'exitCode':run.returncode,'elapsedSeconds':(datetime.datetime.now(datetime.timezone.utc)-start).total_seconds(),'stdout':run.stdout,'stderr':run.stderr});print('PASS'if run.returncode==0 else'FAIL',flush=True)
    if run.returncode:report['status']='FAIL';destination.write_bytes((json.dumps(report,indent=2)+'\n').encode('utf8'));print(run.stdout+run.stderr);sys.exit(1)
report['status']='PASS_DESKTOP_COMPATIBILITY_ONLY';report['finishedUtc']=datetime.datetime.now(datetime.timezone.utc).isoformat();report['identities']={}
for folder in ('crates','phase2','phase3','phase4','phase5','tools'):
    for p in sorted((root/folder).rglob('*')):
        if p.is_file() and '__pycache__' not in str(p) and p.suffix in ('.rs','.py','.cjs','.toml','.md'):
            report['identities'][p.relative_to(root).as_posix()]=hashlib.sha256(p.read_bytes()).hexdigest()
report['limits']=['Continuous analysis segment only; capture gaps/clipping/filter-support assembly not ported','Cooperative yields between frames, not within-frame latency guarantee or real Worker/device verification','Native sin validation remains oracle-based','LPC/formants/full phonetic production integration remain open']
destination.write_bytes((json.dumps(report,indent=2)+'\n').encode('utf8'));print(json.dumps({'status':report['status'],'topLevelCommandsPassed':len(commands),'previousStageChecks':41}))
