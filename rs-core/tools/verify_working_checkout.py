"""Verify an exact working-tree rs-core snapshot without staging or committing."""
from pathlib import Path
import datetime,hashlib,json,shutil,subprocess,tempfile,sys
ROOT=Path(__file__).resolve().parents[1];PROJECT=ROOT.parent
report_path=ROOT/'reports/working-checkout-verification.json'
if '--reuse-copy' in sys.argv:
 previous=json.loads(report_path.read_text(encoding='utf8'));destination=Path(previous['copy']).resolve();assert destination.name.startswith('working-port-')
else:destination=Path(tempfile.mkdtemp(prefix='working-port-',dir=ROOT/'_work')).resolve()
assert destination.is_relative_to((ROOT/'_work').resolve())
subprocess.run(['git','checkout-index','--all','--force','--prefix='+destination.as_posix()+'/'],cwd=PROJECT,check=True)
listed=subprocess.run(['git','ls-files','--cached','--others','--exclude-standard','-z','--','rs-core'],cwd=PROJECT,capture_output=True,check=True).stdout.decode('utf8').split('\0')
inputs={}
for name in sorted(set(n for n in listed if n)):
 source=(PROJECT/name).resolve();target=(destination/name).resolve();assert source.is_relative_to(ROOT) and target.is_relative_to(destination/'rs-core')
 relative=source.relative_to(ROOT).as_posix();assert not any(p in ('target','_work','__pycache__') for p in Path(relative).parts)
 if source.is_file():
  target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target)
  if not relative.startswith('reports/'):inputs[relative]=hashlib.sha256(target.read_bytes()).hexdigest()
 elif target.is_file():target.unlink()
print('Exact working snapshot: '+str(destination),flush=True)
stage=13 if '--phase13' in sys.argv else 12 if '--phase12' in sys.argv else 11 if '--phase11' in sys.argv else 10
run=subprocess.run(['python',f'tools/run-phase{stage}.py','--repository-clean'],cwd=destination/'rs-core',capture_output=True,text=True,encoding='utf8',errors='replace',timeout=1200 if stage==13 else 540)
report={'status':'PASS' if run.returncode==0 else 'FAIL','utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'copy':str(destination),'exitCode':run.returncode,'inputIdentities':inputs,'stdout':run.stdout,'stderr':run.stderr,'scope':'Working rs-core bytes over a read-only index checkout; no git staging/commit/push'}
if run.returncode==0:
 for name,digest in inputs.items():
  assert hashlib.sha256((ROOT/name).read_bytes()).hexdigest()==digest,name
  assert hashlib.sha256((destination/'rs-core'/name).read_bytes()).hexdigest()==digest,('Snapshot changed',name)
 report['verification']=json.loads((destination/f'rs-core/reports/phase{stage}-verification.json').read_text(encoding='utf8'))
report_path.write_bytes((json.dumps(report,indent=2)+'\n').encode('utf8'));print(run.stdout)
if run.returncode:print(run.stderr)
raise SystemExit(run.returncode)
