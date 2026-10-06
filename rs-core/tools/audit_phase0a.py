"""Read-only audit of the completed probe report and source/artifact identities."""
from pathlib import Path
import hashlib
import json
import re

root = Path(__file__).resolve().parents[1]
def digest(path):
    resolved = path.resolve()
    assert resolved.is_relative_to(root)
    return hashlib.sha256(resolved.read_bytes()).hexdigest()

report = json.loads((root/'reports/phase0a-report.json').read_text(encoding='utf-8'))
assert report['overall_status'] == 'PASSED_HOST_VERIFICATION_PENDING_WECHAT_DEVICE'
stages = report['stages']
for key in ['1_preflight','2_native_tests','3_wasm_build','4_node_acceptance','5_asset_and_host_sync']:
    assert stages[key]['status'] == 'PASSED', key
assert stages['6_wechat_device_verification']['status'] == 'UNRUN'
native = stages['2_native_tests']
assert native['exit_code'] == 0
count = sum(int(v) for v in re.findall(r'test result: ok\. (\d+) passed; 0 failed; 0 ignored;',native['stdout']))
assert count == 12, count
node = stages['4_node_acceptance']['details']
assert stages['4_node_acceptance']['exit_code'] == 0
assert len(node['tests']) == 25 and all(row['passed'] for row in node['tests'])
artifact = root/'target/wasm32v1-none/release/noise_wasm.wasm'
deployed = root/'phase0a/wechat-probe/assets/noise_wasm.wasm'
assert artifact.stat().st_size == node['artifact']['bytes'] == 1656
assert digest(artifact) == digest(deployed) == node['artifact']['sha256']
assert digest(root/'phase0a/probe-host.cjs') == digest(root/'phase0a/wechat-probe/probe-host.js')
shape = json.loads((root/'reports/phase0a-wx-shape-audit.json').read_text(encoding='utf-8'))
assert shape['status'] == 'PASS' and shape['artifactSha256'] == digest(artifact)
app = json.loads((root/'phase0a/wechat-probe/app.json').read_text(encoding='utf-8'))
project = json.loads((root/'phase0a/wechat-probe/project.config.json').read_text(encoding='utf-8'))
assert not app.get('permission') and project['appid'] == 'touristappid'
files = [root/'Cargo.toml',root/'Cargo.lock',root/'rust-toolchain.toml',root/'tools/run-phase0a.py']
files += [p for p in (root/'crates').rglob('*') if p.is_file()]
files += [p for p in (root/'phase0a').rglob('*') if p.is_file() and p.suffix in ['.cjs','.js','.json','.wxml','.wxss']]
result = {'status':'PASS','nativeTests':count,'nodeChecks':len(node['tests']),
          'wasmBytes':artifact.stat().st_size,'wasmSha256':digest(artifact),
          'sourceHashes':{p.relative_to(root).as_posix():digest(p) for p in sorted(files)},
          'deviceStatus':'UNRUN','workerStatus':'UNRUN','scope':'Probe host verification; no acoustic migration or device gate completion.'}
(root/'reports/phase0a-independent-audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({k:v for k,v in result.items() if k!='sourceHashes'},ensure_ascii=False))
