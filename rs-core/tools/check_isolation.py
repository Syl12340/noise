"""Verify the frozen export and the narrow Phase 0 production change scope."""
from pathlib import Path
import hashlib
import json
import subprocess

ROOT = Path(__file__).resolve().parents[2]
manifest = json.loads((ROOT/'rs-core/phase0/BASELINE_SOURCE_MANIFEST.json').read_text(encoding='utf-8'))
source = ROOT/'rs-core/_work/baseline'
changed = [name for name,digest in manifest['files'].items()
           if not (source/name).is_file() or hashlib.sha256((source/name).read_bytes()).hexdigest()!=digest]
result = subprocess.run(['git','diff','--name-only'],cwd=ROOT,capture_output=True,text=True,check=True)
unexpected = [name for name in result.stdout.splitlines()
              if name not in {'project.private.config.json','project.config.json'}]
baseline_config = json.loads((source/'project.config.json').read_text(encoding='utf-8'))
current_config = json.loads((ROOT/'project.config.json').read_text(encoding='utf-8'))
entries = current_config['packOptions']['ignore']
excluded = any(item=={'type':'folder','value':'rs-core'} for item in entries)
current_config['packOptions']['ignore'] = [item for item in entries if item!={'type':'folder','value':'rs-core'}]
config_ok = current_config == baseline_config
report = {'baselineCommit':manifest['baselineCommit'], 'baselineFilesChecked':len(manifest['files']),
          'baselineChangedFiles':changed, 'unexpectedTrackedChanges':unexpected,
          'rsCoreExcludedFromPackage':excluded,'onlyAddedPackageExclusion':config_ok,
          'note':'Pre-existing project.private.config.json change is outside this task and remains untouched.'}
print(json.dumps(report,ensure_ascii=False))
if changed or unexpected or not excluded or not config_ok:
    raise SystemExit(1)
