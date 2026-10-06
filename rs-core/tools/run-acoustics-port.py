"""Build and audit the isolated native acoustic port. Never modify production or golden files."""
from pathlib import Path
import hashlib,json,subprocess,time
ROOT=Path(__file__).resolve().parents[1]
REPORT=ROOT/'reports/acoustics-port-report.json'
COMMANDS=[
 ['python','tools/check_port_isolation.py'],
 ['cargo','test','-p','noise-core','--features','acoustics','--locked','--offline'],
 ['cargo','build','-p','noise-core','--example','acoustics_driver','--features','acoustics','--release','--locked','--offline'],
 ['node','phase1/compare-acoustics.cjs'],
 ['cargo','build','-p','noise-core','--features','acoustics','--target','wasm32-unknown-unknown','--release','--locked','--offline'],
 ['cargo','test','--workspace','--locked','--offline'],
 ['cargo','fmt','--all','--check'],
 ['cargo','clippy','-p','noise-core','--features','acoustics','--all-targets','--locked','--offline','--','-D','warnings'],
 ['python','tools/check_port_isolation.py'],
]
def main():
 report={'date':'2026-10-06','status':'RUNNING','steps':[],
 'scope':'Isolated native legacy noise port; WASM rlib build only, no acoustic WASM API or device/clinical gate.',
 'deviceStatus':'UNRUN','voiceAlgorithms':'not ported','productionIntegration':False}
 for command in COMMANDS:
  start=time.perf_counter()
  try:
   result=subprocess.run(command,cwd=ROOT,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=180)
   step={'command':command,'exitCode':result.returncode,'stdout':result.stdout,'stderr':result.stderr,'seconds':time.perf_counter()-start}
  except (subprocess.TimeoutExpired,OSError) as error:
   step={'command':command,'exitCode':-1,'error':str(error),'seconds':time.perf_counter()-start}
  report['steps'].append(step)
  print(command[:3],step['exitCode'],flush=True)
  if step['exitCode']!=0:
   report['status']='FAIL';REPORT.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');return 1
 report['status']='PASS_NATIVE_COMPATIBILITY_ONLY'
 for key,file in [('p0','acoustics-p0-native-comparison.json'),('units','acoustics-unit-comparison.json')]:
  report[key]=json.loads((ROOT/'reports'/file).read_text(encoding='utf-8'))
 files=[ROOT/'Cargo.toml',ROOT/'Cargo.lock',ROOT/'phase1/NUMERIC_PROFILE_V1.json']
 files += [p for p in (ROOT/'crates/noise-core').rglob('*') if p.is_file()]
 report['sourceHashes']={p.relative_to(ROOT).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(files)}
 REPORT.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
 return 0
if __name__=='__main__':raise SystemExit(main())
