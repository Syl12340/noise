"""Re-run existing checks in an isolated copy; preserve historical evidence."""
from pathlib import Path
import datetime
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import sys
import re

ROOT = Path(__file__).resolve().parents[1]
output_name = sys.argv[sys.argv.index('--output-name') + 1] if '--output-name' in sys.argv else 'scientific-validation-2026-10-05'
if not re.fullmatch(r'[a-z0-9-]+', output_name):
    raise ValueError('Output must be a directory name within docs')
OUTPUT = ROOT / 'docs' / output_name

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def praat_python():
    roots = [Path(tempfile.gettempdir()), Path(os.environ.get('LOCALAPPDATA', 'C:/Users/Shaoyilei/AppData/Local')) / 'Temp']
    candidates = [Path(os.sys.executable)]
    for root in roots:
        for directory in root.glob('noise*'):
            if directory.is_dir():
                candidates.extend(directory.glob('**/Scripts/python.exe'))
    for candidate in candidates:
        check = subprocess.run([str(candidate), '-c', 'import numpy, parselmouth; print(numpy.__version__, parselmouth.__version__, parselmouth.PRAAT_VERSION)'],
                               capture_output=True, text=True, timeout=20)
        if check.returncode == 0:
            print('Praat environment:', check.stdout.strip(), flush=True)
            return str(candidate)
    return None

def resume_praat():
    evidence = json.loads((OUTPUT / 'run-manifest.json').read_text(encoding='utf-8'))
    stage = Path(evidence['isolatedWorkingDirectory'])
    python = praat_python()
    if not python:
        print('Existing Praat environment unavailable; no packages installed.', flush=True)
        return
    command = [python, 'tests/praat-comparison.py']
    start = datetime.datetime.now(datetime.timezone.utc)
    result = subprocess.run(command, cwd=stage, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=600)
    (OUTPUT / 'praat-comparison.log').write_text(result.stdout + '\nSTDERR:\n' + result.stderr, encoding='utf-8')
    evidence['commands'].append({'command':command, 'exitCode':result.returncode,
        'seconds':(datetime.datetime.now(datetime.timezone.utc)-start).total_seconds(), 'log':'praat-comparison.log'})
    if (stage/'docs/praat-comparison-results.json').exists():
        shutil.copy2(stage/'docs/praat-comparison-results.json', OUTPUT/'praat-comparison-results.json')
    evidence['praatPython'] = python
    evidence['praatStatus'] = 'executed'
    evidence['originalFilesUnchanged'] = all(sha(ROOT/name)==value for name,value in evidence['sourceSnapshot'].items())
    (OUTPUT/'run-manifest.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print('Praat exit=',result.returncode,flush=True)

def main():
    OUTPUT.mkdir(exist_ok=True)
    manifest = json.loads((ROOT / 'docs/paper-acoustics-engineering-evidence-2026-10-04.json').read_text(encoding='utf-8'))
    before = {name: sha(ROOT / name) for name in [*manifest['sourceSha256'], *manifest['reportSha256']]}
    for name in ['utils/phonetic/fractional-correlation.js']:
        if (ROOT/name).is_file():
            before[name] = sha(ROOT/name)
    differences = {kind: [name for name, value in manifest[kind].items() if sha(ROOT / name) != value]
                   for kind in ['sourceSha256', 'reportSha256']}
    paper_path = ROOT / 'docs/paper-acoustic-algorithms-and-engineering.md'
    stage = Path(tempfile.mkdtemp(prefix='noise-scientific-validation-20261005-'))
    for folder in ['utils', 'pages', 'workers', 'scripts', 'tests', 'images']:
        if (ROOT / folder).is_dir():
            shutil.copytree(ROOT / folder, stage / folder, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    for name in ['app.js', 'app.json', 'app.wxss', 'project.config.json']:
        if (ROOT / name).exists():
            shutil.copy2(ROOT / name, stage / name)
    (stage / 'docs').mkdir()
    # Include only tab icon assets required by the package-integrity check.
    app = json.loads((ROOT / 'app.json').read_text(encoding='utf-8'))
    for item in app.get('tabBar', {}).get('list', []):
        for key in ['iconPath', 'selectedIconPath']:
            if key in item:
                target = stage / item[key]
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ROOT / item[key], target)
    scripts = ['rc-repairs.cjs', 'recorder-usability.cjs', 'scientific-followup.cjs',
               'scientific-repairs.cjs', 'revision-regression.cjs', 'package-integrity.cjs',
               'algorithm-evaluation.cjs', 'formant-validation.cjs', 'formant-holdout.cjs',
               'paper-scientific-probes.cjs', 'paper-engineering-repairs.cjs', 'paper-scientific-followup-probes.cjs']
    if '--probes-only' in sys.argv:
        scripts = ['paper-scientific-probes.cjs', 'paper-scientific-followup-probes.cjs']
    commands = [['node', 'tests/' + name] for name in scripts]
    # Reuse an existing independent environment, never install or change packages.
    python = praat_python()
    if python and '--probes-only' not in sys.argv:
        commands.append([python, 'tests/praat-comparison.py'])
    records = []
    for command in commands:
        name = Path(command[-1]).stem
        if not (stage / command[-1]).exists():
            continue
        start = datetime.datetime.now(datetime.timezone.utc)
        result = subprocess.run(command, cwd=stage, capture_output=True, text=True,
                                encoding='utf-8', errors='replace', timeout=600)
        log = result.stdout + '\nSTDERR:\n' + result.stderr
        (OUTPUT / (name + '.log')).write_text(log, encoding='utf-8')
        records.append({'command': command, 'exitCode': result.returncode,
                        'seconds': (datetime.datetime.now(datetime.timezone.utc) - start).total_seconds(),
                        'log': name + '.log'})
        print(name, 'exit=', result.returncode, flush=True)
    for file in (stage / 'docs').glob('*.json'):
        shutil.copy2(file, OUTPUT / file.name)
    after = {name: sha(ROOT / name) for name in before}
    evidence = {
        'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'sourceSnapshot': before, 'differencesFromPaperSnapshot': differences,
        'manuscriptMatchesRecordedHash': sha(paper_path) == manifest['manuscriptSha256'],
        'originalFilesUnchanged': before == after,
        'isolatedWorkingDirectory': str(stage), 'commands': records,
        'praatPython': python, 'praatStatus': 'not-requested' if '--probes-only' in sys.argv else 'executed' if python else 'existing-environment-unavailable',
        'note': 'Nonzero scientific gate exits are retained; sources and historical reports are preserved during isolated execution.'
    }
    (OUTPUT / 'run-manifest.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'output': str(OUTPUT), 'differences': differences, 'originalFilesUnchanged': before == after}, ensure_ascii=False), flush=True)

if __name__ == '__main__':
    resume_praat() if '--praat-only' in sys.argv else main()
