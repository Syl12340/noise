"""Full-speech acceptance after every earlier narrow build."""
from pathlib import Path
import datetime,hashlib,json,subprocess,sys
root=Path(__file__).resolve().parents[1];clean=['--repository-clean'] if '--repository-clean' in sys.argv else []
commands=[['python','tools/run-phase12.py']+clean,
 ['python','tools/check_full_tables.py'],
 ['cargo','test','--workspace','--all-features','--locked','--offline'],
 ['cargo','fmt','--all','--','--check'],
 ['cargo','clippy','--workspace','--all-features','--all-targets','--locked','--offline','--','-D','warnings'],
 ['cargo','build','-p','noise-wasm','--features','full-speech','--example','full_speech_driver','--release','--locked','--offline'],
 ['cargo','build','-p','noise-wasm','--features','full-speech','--target','wasm32-unknown-unknown','--release','--locked','--offline'],
 ['node','phase13/check-imports.cjs'],['node','phase13/check-full.cjs'],['node','phase13/check-domain.cjs'],
 ['python','tools/check_port_isolation.py']+clean]
report={'status':'RUNNING','commands':[],'repositoryCleanMode':bool(clean)};destination=root/'reports/phase13-verification.json'
for command in commands:
 print('RUN '+' '.join(command),flush=True);start=datetime.datetime.now(datetime.timezone.utc)
 run=subprocess.run(command,cwd=root,capture_output=True,text=True,encoding='utf8',errors='replace',timeout=900)
 report['commands'].append({'command':command,'exitCode':run.returncode,'elapsedSeconds':(datetime.datetime.now(datetime.timezone.utc)-start).total_seconds(),'stdout':run.stdout,'stderr':run.stderr})
 if run.returncode:
  report['status']='FAIL';destination.write_bytes((json.dumps(report,indent=2)+'\n').encode('utf8'));print(run.stdout+run.stderr);sys.exit(1)
 print('PASS',flush=True)
report['identities']=json.loads((root/'reports/phase12-verification.json').read_text(encoding='utf8'))['identities']
for folder in ('phase13','coefficients/full-speech-v1'):
 for p in sorted((root/folder).rglob('*')):
  if p.is_file():report['identities'][p.relative_to(root).as_posix()]=hashlib.sha256(p.read_bytes()).hexdigest()
report['status']='PASS_DESKTOP_COMPATIBILITY_ONLY';report['finishedUtc']=datetime.datetime.now(datetime.timezone.utc).isoformat()
report['limits']=['Native acceptance uses recorded JS math, not live libm qualification','Full v2 is separate from old PCM-HNR Worker v1; artifact exceeds its4MiB limit','No mini-program integration, WX/Android package/runtime/latency or clinical validity claim','Optional model-sensitivity and selection-offset adapter remain outside this standard full-result profile']
destination.write_bytes((json.dumps(report,indent=2)+'\n').encode('utf8'));print(json.dumps({'status':report['status'],'topLevelCommandsPassed':len(commands)}))
