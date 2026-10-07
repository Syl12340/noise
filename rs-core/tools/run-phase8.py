"""Offline PCM primitives and actual WASM PCM-to-HNR, with all prior regressions."""
from pathlib import Path
import datetime,hashlib,json,subprocess,sys
root=Path(__file__).resolve().parents[1];clean=['--repository-clean'] if '--repository-clean' in sys.argv else []
commands=[['python','tools/run-phase7.py']+clean,
 ['cargo','build','-p','noise-wasm','--features','speech','--example','pcm_driver','--release','--locked','--offline'],
 ['node','phase8/check-pcm.cjs']]
report={'status':'RUNNING','commands':[],'repositoryCleanMode':bool(clean)};destination=root/'reports/phase8-verification.json'
for command in commands:
 print('RUN '+' '.join(command),flush=True);run=subprocess.run(command,cwd=root,capture_output=True,text=True,encoding='utf8',errors='replace',timeout=360)
 report['commands'].append({'command':command,'exitCode':run.returncode,'stdout':run.stdout,'stderr':run.stderr})
 if run.returncode:
  report['status']='FAIL';destination.write_bytes((json.dumps(report,indent=2)+'\n').encode('utf8'));print(run.stdout+run.stderr);sys.exit(1)
 print('PASS',flush=True)
report['identities']=json.loads((root/'reports/phase7-verification.json').read_text(encoding='utf8'))['identities']
for p in sorted((root/'phase8').rglob('*')):
 if p.is_file():report['identities'][p.relative_to(root).as_posix()]=hashlib.sha256(p.read_bytes()).hexdigest()
report['status']='PASS_DESKTOP_COMPATIBILITY_ONLY';report['finishedUtc']=datetime.datetime.now(datetime.timezone.utc).isoformat()
report['limits']=['Native PCM primitives and desktop WASM HNR slice only','YIN/resampling synchronous; Worker/device latency remains unqualified','No production integration or LPC/formants/intensity/spectrogram/jitter']
destination.write_bytes((json.dumps(report,indent=2)+'\n').encode('utf8'));print(json.dumps({'status':report['status'],'topLevelCommandsPassed':len(commands)}))
