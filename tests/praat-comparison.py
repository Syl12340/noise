"""Independent Praat comparison; requires numpy and praat-parselmouth 0.4.7.

Frozen configuration: do not tune the production algorithm against this set.
The 10% error / 80% coverage gate remains unchanged; missing != accurate.
"""
import hashlib
import json
import math
from pathlib import Path
import subprocess
import tempfile
from datetime import datetime, timezone
import numpy as np
import parselmouth

ROOT = Path(__file__).resolve().parent.parent
SEED = 261002
RNG = np.random.default_rng(SEED)
POLES = [
    [(390, 75), (1460, 120), (2840, 175), (3980, 245), (4790, 315)],
    [(720, 100), (1950, 140), (3210, 195), (4070, 255), (4860, 335)],
    [(810, 120), (1090, 110), (2510, 185), (3640, 230), (4700, 310)],
]


def synth(f0, poles, rate):
    count = round(rate * .5)
    t = np.arange(count) / rate
    phase = RNG.uniform(0, 2 * np.pi)
    x = sum(np.cos(2 * np.pi * k * f0 * t + phase * k) / np.sqrt(k)
            for k in range(1, int(rate * .45 / f0) + 1))
    for f, bw in poles:
        r = np.exp(-np.pi * bw / rate)
        a, b = 2 * r * np.cos(2 * np.pi * f / rate), r * r
        y = np.zeros(count)
        for i in range(count):
            y[i] = x[i] + (a * y[i - 1] if i else 0) - (b * y[i - 2] if i > 1 else 0)
        x = y / max(abs(y))
    # A fixed source tilt, not a fitted production pre-emphasis inverse.
    tilt = np.exp(-2 * np.pi * 150 / rate)
    for i in range(1, count):
        x[i] += tilt * x[i - 1]
    return np.rint(x / max(abs(x)) * 10000).astype('<i2')


def metrics(errors, total):
    return dict(truthFrames=total, acceptedFrames=len(errors), coverage=len(errors) / total,
                wrongAcceptedFrames=sum(e > .1 for e in errors),
                maxRelativeError=max(errors) if errors else None)


def reference_times(sample_count, input_rate):
    # Frozen production-test configuration, independent of output metadata.
    analysis_rate, frame_size, hop_size = 12000, 300, 120
    count = math.floor(sample_count * analysis_rate / input_rate)
    return [(start + frame_size / 2) / analysis_rate
            for start in range(0, max(0, count - frame_size + 1), hop_size)
            if .1 - 1e-12 <= (start + frame_size / 2) / analysis_rate <= .4 + 1e-12]


def main():
    fixtures = []
    for p, poles in enumerate(POLES):
        for f0 in [105, 185, 305, 425]:
            fixtures.append(dict(id=f'novel-{p}-{f0}', f0=f0, poles=poles, sampleRate=12000))
    fixtures.append(dict(id='novel-48k', f0=235, poles=POLES[1], sampleRate=48000))
    fixtures.append(dict(id='novel-broad-F1', f0=165,
                         poles=[(690, 610), (1240, 130), (2750, 185), (3700, 250), (4680, 310)], sampleRate=12000))
    fixtures.append(dict(id='existing-failure-400', f0=400,
                         poles=[(500, 80), (1500, 100), (2500, 120)], sampleRate=12000))
    signals = {}
    with tempfile.TemporaryDirectory(prefix='noise-praat-fixtures-') as temporary:
        directory = Path(temporary)
        for fixture in fixtures:
            pcm = synth(fixture['f0'], fixture['poles'], fixture['sampleRate'])
            signals[fixture['id']] = pcm
            fixture['pcmSha256'] = hashlib.sha256(pcm.tobytes()).hexdigest()
            fixture['pcmPath'] = str(directory / (fixture['id'] + '.pcm'))
            pcm.tofile(fixture['pcmPath'])
        manifest, output = directory / 'manifest.json', directory / 'production.json'
        manifest.write_text(json.dumps(fixtures), encoding='utf8')
        subprocess.run(['node', str(ROOT / 'tests/praat-production.cjs'), str(manifest), str(output)],
                       cwd=ROOT, check=True)
        production = {r['id']: r for r in json.loads(output.read_text(encoding='utf8'))}
    cases = []
    aggregate = {key: [[], [], []] for key in ['production', 'praatPhysical25ms', 'praatStandard50ms', 'praatResolutionMatched50ms']}
    total = 0
    invalid_time_grids = 0
    for fixture in fixtures:
        result = production[fixture['id']]
        sound = parselmouth.Sound(signals[fixture['id']].astype(float) / 32768,
                                  sampling_frequency=fixture['sampleRate'])
        # Production guard-band LPC is 12 kHz / order 12. Praat resamples to
        # 2*ceiling; ceiling=6000 and max_number_of_formants=6 matches these.
        variants = {
            'praatPhysical25ms': sound.to_formant_burg(time_step=.01, max_number_of_formants=6,
                                                      maximum_formant=6000, window_length=.0125,
                                                      pre_emphasis_from=58.17),
            'praatStandard50ms': sound.to_formant_burg(time_step=.01, max_number_of_formants=5,
                                                      maximum_formant=5000, window_length=.025,
                                                      pre_emphasis_from=50),
            # Resolution comparison specified from the official Praat manual:
            # effective 25 ms Gaussian (physical 50 ms) ~ 25 ms Hamming bandwidth.
            'praatResolutionMatched50ms': sound.to_formant_burg(time_step=.01, max_number_of_formants=6,
                                                                maximum_formant=6000, window_length=.025,
                                                                pre_emphasis_from=result['parameters']['preEmphasisFrequencyHz']),
        }
        pitch = sound.to_pitch_ac(time_step=.01, pitch_floor=40, pitch_ceiling=1200)
        times = reference_times(len(signals[fixture['id']]), fixture['sampleRate'])
        rows = [None] * len(times)
        duplicate_rows, unexpected_rows = 0, 0
        for row in result['formantTracks']:
            if not .1 - 1e-12 <= row['time'] <= .4 + 1e-12:
                continue
            matches = [i for i, time in enumerate(times) if abs(row['time'] - time) <= 1e-7]
            if not matches:
                unexpected_rows += 1
            elif rows[matches[0]] is not None:
                duplicate_rows += 1
            else:
                rows[matches[0]] = row
        invalid_time_grids += duplicate_rows + unexpected_rows
        errors = {key: [[], [], []] for key in aggregate}
        comparison_differences = [[], [], []]
        for time, row in zip(times, rows):
            for k in range(3):
                truth = fixture['poles'][k][0]
                value = row[f'F{k+1}']['freq'] if row is not None else 0
                if value > 0:
                    errors['production'][k].append(abs(value / truth - 1))
                for key, formant in variants.items():
                    reference = formant.get_value_at_time(k + 1, time)
                    if np.isfinite(reference) and 90 <= reference <= 5000:
                        errors[key][k].append(abs(reference / truth - 1))
                        if key == 'praatPhysical25ms' and value > 0:
                            comparison_differences[k].append(abs(value - reference))
        novel = fixture['id'] != 'existing-failure-400'
        if novel:
            total += len(rows)
            for key in aggregate:
                for k in range(3):
                    aggregate[key][k].extend(errors[key][k])
        pitch_pairs = [(r['f0'], pitch.get_value_at_time(r['time'])) for r in result['pitchTrack']
                       if .1 <= r['time'] <= .4 and r['f0'] > 0]
        pitch_differences = [abs(a - b) for a, b in pitch_pairs if np.isfinite(b) and b > 0]
        cases.append({**{k: v for k, v in fixture.items() if k != 'pcmPath'},
                      'productionParameters': result['parameters'], 'truthFrames': len(rows),
                      'referenceTimes': times,
                      'timeAlignment': dict(missingRows=sum(row is None for row in rows),
                                            duplicateRows=duplicate_rows, unexpectedRows=unexpected_rows),
                      'metrics': {key: [metrics(e, len(rows)) for e in values] for key, values in errors.items()},
                      'meanPraatDifferenceHz': [float(np.mean(e)) if e else None for e in comparison_differences],
                      'pitchMeanDifferenceHz': float(np.mean(pitch_differences)) if pitch_differences else None})
    summary = {key: [metrics(e, total) for e in values] for key, values in aggregate.items()}
    sources = ['utils/phonetic/analysis.js', 'utils/phonetic/formant-extract.js',
               'utils/phonetic/model-sensitivity.js', 'utils/phonetic/selection-analysis.js',
               'utils/phonetic/burg-lpc.js', 'utils/phonetic/poly-roots.js', 'utils/phonetic/resample.js',
               'utils/phonetic/yin-pitch.js', 'utils/audio-quality.js', 'utils/measurement-version.js',
               'tests/praat-comparison.py', 'tests/praat-production.cjs']
    report = dict(generatedAt=datetime.now(timezone.utc).isoformat(), seed=SEED,
                  versions=dict(numpy=np.__version__, parselmouth=parselmouth.__version__,
                                praat=parselmouth.PRAAT_VERSION),
                  criterion='10% frequency tolerance, 80% truth-frame coverage; no wrong accepted frames. Missing remains missing.',
                  method='Exact same Int16 PCM and production frame centres. Physical25ms is a window-shape diagnostic, not equal spectral resolution. ResolutionMatched50ms matches LPC rate/order/pre-emphasis and approximate Hamming frequency resolution (effective25ms/physical50ms Gaussian), still differs in shape, resampling and root filtering. Added this resolution diagnostic after first inspection without changing PCM or production parameters. Standard Praat uses a different rate/order. Novel set frozen before first execution; becomes regression after inspection.',
                  limitations='Synthetic known-pole vowels only. No clinical corpus, calibrated microphone or Android device validation. HNR algorithms/bandwidth/windows differ and are not equated.',
                  sourceSha256={p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in sources},
                  aggregate=summary, cases=cases)
    report['denominator'] = 'independent-frozen-input-time-grid'
    report['invalidTimeGrids'] = invalid_time_grids
    report['productionAccuracyAndCoveragePassed'] = invalid_time_grids == 0 and all(m['coverage'] >= .8 and m['wrongAcceptedFrames'] == 0
                                                      for m in summary['production'])
    (ROOT / 'docs/praat-comparison-results.json').write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n', encoding='utf8')
    print(json.dumps(dict(versions=report['versions'], passed=report['productionAccuracyAndCoveragePassed'], aggregate=summary)))
    return 0 if report['productionAccuracyAndCoveragePassed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
