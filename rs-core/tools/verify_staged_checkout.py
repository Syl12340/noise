"""Verify the staged byte-preserving distribution in a fresh isolated copy."""
from pathlib import Path
import datetime,json,subprocess,tempfile,sys
ROOT=Path(__file__).resolve().parents[1]
PROJECT=ROOT.parent
if '--reuse-copy' in sys.argv:
    previous=json.loads((ROOT/'reports/staged-checkout-verification.json').read_text(encoding='utf8'))
    destination=Path(previous['copy']).resolve()
    assert destination.name.startswith('staged-port-')
else:
    destination=Path(tempfile.mkdtemp(prefix='staged-port-',dir=ROOT/'_work')).resolve()
assert destination.is_relative_to((ROOT/'_work').resolve())
prefix=destination.as_posix()+'/'
subprocess.run(['git','checkout-index','--all','--force','--prefix='+prefix],cwd=PROJECT,check=True)
print('Fresh staged checkout: '+str(destination),flush=True)
stage=4 if '--phase4' in sys.argv else 3
run=subprocess.run(['python',f'tools/run-phase{stage}.py','--repository-clean'],cwd=destination/'rs-core',capture_output=True,text=True,encoding='utf8',errors='replace',timeout=420)
report={'status':'PASS' if run.returncode==0 else 'FAIL','utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'copy':str(destination),'exitCode':run.returncode,'stdout':run.stdout,'stderr':run.stderr}
if run.returncode==0:
    report['verification']=json.loads((destination/f'rs-core/reports/phase{stage}-verification.json').read_text(encoding='utf8'))
(ROOT/'reports/staged-checkout-verification.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf8')
print(run.stdout)
if run.returncode:print(run.stderr)
raise SystemExit(run.returncode)
