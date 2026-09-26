'use strict';
// Standalone deterministic evaluation. Runs production modules; no device or npm dependencies.
// Engineering tolerances below are test criteria, not clinical/IEC acceptance limits.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const load = name => require(path.join(root, name));
const { yinPitchFrame, yinPitchTrack } = load('utils/phonetic/yin-pitch');
const { extractFormantsFromLPC, extractFormants, formantTrack } = load('utils/phonetic/formant-extract');
const { estimateHarmonicity } = load('utils/phonetic/harmonicity');
const { resampleLowPass, emphasizeFloat } = load('utils/phonetic/resample');
const { calculateIntensity, calculatePitchPeriodVariability } = load('utils/phonetic/voice-metrics');
const { AWeightingFilter, calculateLeqFromEnergy, calculateCNEFromLeq } = load('utils/audio-math');
const { computeSpectrum, FFT_CONFIG } = load('utils/fft');
const { computeThirdOctaveBands, BAND_BIN_RANGES, THIRD_OCTAVE_CENTERS } = load('utils/canvas-spectrum');
const { inspectPcm, DCBlocker, centeredSignal } = load('utils/audio-quality');
const { inspectCalibrationTone } = load('utils/calibration-quality');
const results = [];
function check(name, criterion, fn) {
  let detail = {};
  try { detail = fn(); results.push({ name, criterion, ...detail, status: detail.ok ? 'PASS' : 'FAIL' }); }
  catch (error) { results.push({ name, criterion, status: 'ERROR', error: error.stack }); }
}
const db = x => 10 * Math.log10(x);
const rms = a => Math.sqrt(a.reduce((s, x) => s + x*x, 0) / a.length);
const mean = a => a.reduce((s,x) => s+x,0)/a.length;
function tone(f, rate, length, amp = 0.1, phase = 0) {
  return Float64Array.from({ length }, (_,i) => amp * Math.sin(2*Math.PI*f*i/rate+phase));
}
function pcm(a) { return Int16Array.from(a, x => Math.round(Math.max(-1,Math.min(32767/32768,x))*32768)); }
function gaussian(seed) {
  let state = seed >>> 0;
  const uniform = () => { state = (Math.imul(1664525,state)+1013904223)>>>0; return (state+0.5)/4294967296; };
  return () => Math.sqrt(-2*Math.log(uniform()))*Math.cos(2*Math.PI*uniform());
}
function polynomial(formants, rate=12000) {
  let a = [1];
  for (const [f,bw] of formants) {
    const r=Math.exp(-Math.PI*bw/rate), b=[1,-2*r*Math.cos(2*Math.PI*f/rate),r*r];
    const next=Array(a.length+2).fill(0);
    for(let i=0;i<a.length;i++) for(let j=0;j<3;j++) next[i+j]+=a[i]*b[j];
    a=next;
  }
  return Float64Array.from(a);
}
function allPole(excitation,a) {
  const out=new Float64Array(excitation.length);
  for(let i=0;i<out.length;i++) { out[i]=excitation[i]; for(let j=1;j<a.length&&j<=i;j++) out[i]-=a[j]*out[i-j]; }
  const scale=0.1/rms(out);
  return out.map(x=>x*scale);
}
function magnitude(coeff,f,rate) {
  let re=0,im=0; for(let i=0;i<coeff.length;i++) {re+=coeff[i]*Math.cos(2*Math.PI*f*i/rate);im-=coeff[i]*Math.sin(2*Math.PI*f*i/rate);}
  return Math.hypot(re,im);
}
function analogA(f) {
  // Independent direct evaluation of the analog pole/zero prototype, normalized at 1 kHz.
  const response=x=>12194.217**2*x**4/((x*x+20.598997**2)*Math.sqrt((x*x+107.65265**2)*(x*x+737.86223**2))*(x*x+12194.217**2));
  return 20*Math.log10(response(f)/response(1000));
}

for(const f of [40,40.1,50,80,100,150,200,300,500,800,1000,1190,1199,1200]) {
  check(`YIN pure tone ${f} Hz`, 'All 4 phases voiced, relative F0 error <= 1%', () => {
    const trials=[0,0.4,1.5,2.9].map(phase=>yinPitchFrame(tone(f,12000,1024,.1,phase),12000,.1,40,1200));
    const maxRelativeError=Math.max(...trials.map(t=>Math.abs(t.f0-f)/f));
    return {ok:trials.every(t=>t.f0>0)&&maxRelativeError<=.01,maxRelativeError,trials};
  });
}
for(const f of [30,39,1201,1205,1250,1500,1800,2000,2500,3000]) {
  check(`YIN out-of-range ${f} Hz`, 'All 4 phases rejected, no lower-octave substitution', () => {
    const trials=[0,.4,1.5,2.9].map(phase=>yinPitchFrame(tone(f,12000,1024,.1,phase),12000,.1,40,1200));
    return {ok:trials.every(t=>t.f0===0),trials};
  });
}
check('YIN silence and seeded white noise','Silence rejected; noise voiced fraction <= 5%',()=>{
  const rng=gaussian(1),noise=Float64Array.from({length:12000},()=>rng()*.1);
  const track=yinPitchTrack(noise,12000,{frameSize:1024,hopSize:120,fmin:40,fmax:1200});
  const voicedFraction=track.filter(x=>x.f0>0).length/track.length;
  return {ok:yinPitchFrame(new Float64Array(1024),12000,.1,40,1200).f0===0&&voicedFraction<=.05,voicedFraction};
});
check('YIN weak/missing fundamental','100 Hz periodic harmonic complexes within 1%',()=>{
  const trials=[[.1,.8,.3],[0,.8,.5]].map(amplitudes=>{
    const x=Float64Array.from({length:1024},(_,i)=>amplitudes.reduce((s,a,j)=>s+a*Math.sin(2*Math.PI*100*(j+1)*i/12000+.2*j),0));
    return yinPitchFrame(x,12000,.1,40,1200);
  });return {ok:trials.every(x=>Math.abs(x.f0-100)<=1),trials};
});
check('YIN analysis timestamps','First frame at 1024/(2*12000), hop 0.01 s',()=>{
  const t=yinPitchTrack(tone(200,12000,2400),12000,{frameSize:1024,hopSize:120,fmin:40,fmax:1200});
  return {ok:Math.abs(t[0].time-1024/24000)<1e-12&&Math.abs(t[1].time-t[0].time-.01)<1e-12,first:t[0].time};
});

for(const [name,poles,expected] of [
  ['known poles',[[500,80],[1500,120],[2500,180]],[500,1500,2500]],
  ['low artifact excluded',[[50,40],[500,80],[1500,120],[2500,180]],[500,1500,2500]],
  ['broad F1 keeps numbering',[[500,600],[1500,120],[2500,180]],[0,1500,2500]],
  ['broad F2 keeps numbering',[[500,80],[1500,600],[2500,180]],[500,0,2500]]
]) {
  check(`Formant roots: ${name}`,'Known frequencies <= 0.2 Hz; invalid slot remains missing',()=>{
    const r=extractFormantsFromLPC(polynomial(poles),12000), frequencies=[r.F1.freq,r.F2.freq,r.F3.freq];
    return {ok:frequencies.every((f,i)=>Math.abs(f-expected[i])<=.2),frequencies,expected,bandwidths:[r.F1.bandwidth,r.F2.bandwidth,r.F3.bandwidth]};
  });
}
check('Burg LPC broadband all-pole identification','Known AR(6), 1 second: F1/F2/F3 within 5%',()=>{
  const rng=gaussian(42),x=allPole(Float64Array.from({length:24000},()=>rng()),polynomial([[500,80],[1500,120],[2500,180]]));
  const r=extractFormants(x.slice(12000),6,12000),actual=[r.F1.freq,r.F2.freq,r.F3.freq],expected=[500,1500,2500];
  return {ok:actual.every((f,i)=>Math.abs(f-expected[i])/expected[i]<.05),actual,expected};
});
for(const f0 of [100,200,400]) {
  check(`Vowel pipeline F0=${f0} Hz`,'Resolvable formants within 10% and >=80% coverage; F1 below 1.5*F0 is missing',()=>{
    const n=12000,source=Float64Array.from({length:n},(_,i)=>i%(12000/f0)===0?1:0);
    const x=allPole(source,polynomial([[500,80],[1500,120],[2500,180]]));
    // Excitation with spectral tilt; page pre-emphasis approximately reverses it.
    const tilted=new Float64Array(n);for(let i=0;i<n;i++) tilted[i]=x[i]+(i? .97*tilted[i-1]:0);
    const pitch=yinPitchTrack(tilted,12000,{frameSize:1024,hopSize:120,fmin:40,fmax:1200});
    const t=formantTrack(emphasizeFloat(tilted),12000,{pitchTrack:pitch});
    const trimmed=t.filter(row=>row.time>=.1&&row.time<=.9);
    const expected=[500,1500,2500];
    const slots=['F1','F2','F3'].map((key,i)=>{const a=trimmed.map(r=>r[key].freq).filter(f=>f>0).sort((a,b)=>a-b); const median=a.length?a[Math.floor(a.length/2)]:null;return {median,coverage:a.length/trimmed.length,relativeError:median===null?null:Math.abs(median-expected[i])/expected[i]};});
    const f1ExpectedMissing = 500 < 1.5 * f0;
    const f1Ok = f1ExpectedMissing ? slots[0].coverage===0 : slots[0].coverage>=.8&&slots[0].relativeError<=.1;
    return {ok:f1Ok&&slots.slice(1).every(x=>x.coverage>=.8&&x.relativeError<=.1),slots,f1ExpectedMissing};
  });
}

const aFilter=new AWeightingFilter(44100);
check('A-weighting transfer response','20..20000 Hz, <= 0.5 dB from normalized analog target',()=>{
  const trials=[20,25,31.5,63,100,200,500,1000,2000,4000,8000,10000,12500,16000,20000].map(f=>{
    const actual=20*Math.log10(aFilter.gain*magnitude(aFilter.b1,f,44100)/magnitude(aFilter.a1,f,44100)*magnitude(aFilter.b2,f,44100)/magnitude(aFilter.a2,f,44100)*magnitude(aFilter.fir,f,44100));
    return {f,actual,expected:analogA(f),error:actual-analogA(f)};
  });const maxError=Math.max(...trials.map(t=>Math.abs(t.error)));return {ok:maxError<=.5,maxError,trials};
});
check('A-weighting time-domain level and chunk invariance','1 kHz level error < 0.02 dB; identical contiguous/chunked outputs',()=>{
  const x=tone(1000,44100,88200),whole=new AWeightingFilter(44100).process(x,false),filter=new AWeightingFilter(44100),parts=[];
  for(let i=0;i<x.length;i+=1379) parts.push(...filter.process(x.slice(i,i+1379),false));
  let maxSampleError=0;for(let i=0;i<whole.length;i++)maxSampleError=Math.max(maxSampleError,Math.abs(whole[i]-parts[i]));
  const error=20*Math.log10(rms(whole.slice(44100))/(.1/Math.sqrt(2)));
  return {ok:Math.abs(error)<.02&&maxSampleError===0,error,maxSampleError};
});
check('Leq and exposure energy weighting','Unequal durations integrated by energy; 2h vs 8h = -6.0206 dB',()=>{
  const expected=10*Math.log10((100*10**(60/10)+300*10**(80/10))/400);
  const actual=calculateLeqFromEnergy(100*.0001+300*.01,400,100);
  const exposure=calculateCNEFromLeq(actual,10*Math.log10(7200/28800));
  return {ok:Math.abs(actual-expected)<1e-10&&Math.abs(exposure-actual+6.020599913279624)<1e-10,actual,expected,exposure};
});
for(const f of [25,31.5,1000,1000.37,16000,20000]) {
  check(`FFT energy / band ${f} Hz`,'Total sine energy error < 0.01 dB; center-band error < 0.25 dB where applicable',()=>{
    const spectrum=computeSpectrum(pcm(tone(f,44100,FFT_CONFIG.SIZE)),0),actual=db(spectrum.reduce((s,v)=>s+10**(v/10),0));
    const expected=20*Math.log10(.1/Math.sqrt(2)),index=THIRD_OCTAVE_CENTERS.indexOf(f),band=index<0?null:computeThirdOctaveBands(spectrum)[index];
    return {ok:Math.abs(actual-expected)<.01&&(band===null||Math.abs(band-expected)<.25),actual,expected,error:actual-expected,band,bandError:band===null?null:band-expected};
  });
}
check('Third-octave bin partition','No overlapping or missing bins between adjacent bands',()=>{
  const gaps=BAND_BIN_RANGES.slice(1).map((r,i)=>r.startBin-BAND_BIN_RANGES[i].endBin-1);
  return {ok:gaps.every(g=>g===0)&&BAND_BIN_RANGES.every(r=>r.endBin>=r.startBin),gaps};
});
for(const f of [1000,4500,5000,7000,10000,16000]) {
  check(`Resampling ${f} Hz 44100 -> 12000`,'Passband <= 0.1 dB through 5 kHz; stopband attenuation >= 60 dB',()=>{
    const out=resampleLowPass(tone(f,44100,22050),44100,12000,5500),interior=out.slice(200,-200);
    const gainDb=20*Math.log10(rms(interior)/(.1/Math.sqrt(2)));
    return {ok:f<=5000?Math.abs(gainDb)<.1:gainDb<=-60,gainDb,outputSamples:out.length};
  });
}
for(const snr of [0,10,20]) {
  check(`HNR known signal/noise ratio ${snr} dB`,'1 second sine + seeded Gaussian noise: mean HNR within 2 dB across 4 seeds',()=>{
    const trials=[1,2,3,4].map(seed=>{const rng=gaussian(seed),x=tone(200,12000,12000),sigma=.1/Math.sqrt(2)*10**(-snr/20);for(let i=0;i<x.length;i++)x[i]+=sigma*rng();return estimateHarmonicity(x,12000);});
    const estimated=trials.map(t=>t.avgHNR),bias=mean(estimated)-snr;
    return {ok:trials.every(t=>t.coverage===1&&t.avgHNR!==null)&&Math.abs(bias)<=2,estimated,bias};
  });
}
check('HNR pure tone and silence','Periodic tone >= 40 dB, silence missing',()=>{
  const toneResult=estimateHarmonicity(tone(200,12000,12000),12000),silence=estimateHarmonicity(new Float64Array(12000),12000);
  return {ok:toneResult.avgHNR>=40&&silence.avgHNR===null&&silence.activeFrames===0,toneHNR:toneResult.avgHNR,cappedFrames:toneResult.cappedFrames,silenceHNR:silence.avgHNR};
});
check('Intensity and frame period metric','1 kHz RMS dBFS +/-0.01 dB; unvoiced break never paired',()=>{
  const values=calculateIntensity(tone(1000,44100,44100),44100,1102,441),expected=20*Math.log10(.1/Math.sqrt(2));
  const maxError=Math.max(...values.map(t=>Math.abs(t.db-expected))),missing=calculatePitchPeriodVariability([{f0:100},{f0:0},{f0:200}]);
  return {ok:maxError<.01&&missing===null,maxError,missing};
});
check('PCM quantized low-frequency plateau','100 Hz, amplitude 2000 PCM, must not be clipped',()=>{
  const quality=inspectPcm(Int16Array.from({length:8192},(_,i)=>Math.round(2000*Math.cos(2*Math.PI*100*i/44100))));
  return {ok:!quality.clipped&&!quality.digitalSilence,quality};
});
check('PCM rails, near-full, constant DC','Rails/near-full clipped; constant nonzero PCM invalid AC',()=>{
  const rail=inspectPcm(Int16Array.from([0,32767,-32768,0])),near=inspectPcm(pcm(tone(1000,44100,8192,.99))),dc=inspectPcm(new Int16Array(8192).fill(1234));
  return {ok:rail.clipped&&near.clipped&&dc.digitalSilence&&dc.noAcSignal,rail,near,dc};
});
for(const [name,make,expected] of [
  ['stable 1 kHz',()=>tone(1000,44100,88200),true],
  ['wrong frequency',()=>tone(800,44100,88200),false],
  ['silent',()=>new Float64Array(88200),false],
  ['level jump',()=>tone(1000,44100,88200).map((x,i)=>i<44100?x:x/2),false],
  ['corrupt tail',()=>tone(1000,44100,88200).map((x,i)=>i<86000?x:.2*Math.sin(2*Math.PI*3000*i/44100)),false]
])check(`Calibration tone: ${name}`,'Expected validity = '+expected,()=>{const result=inspectCalibrationTone(make(),44100);return {ok:result.valid===expected,...result};});

// Isolated WeChat runtime: production CommonJS modules + fake clock/recorder/storage.
// Canvas and persistence sink are mocked; arithmetic and state transitions are real.
const { runtime } = require('./runtime.cjs');
function preparePage(file,calibrated=false){
  const env=runtime();
  if(calibrated){const session=env.load('utils/recorder-session.js');env.load('utils/data-model.js').setOffset(100,{captureProfile:session.getMeasurementCaptureProfile(),deviceId:session.getCurrentDeviceCalibrationId()});env.storage.set('alarm',false);}
  env.load(file);env.page.onShow();env.clock.tick(50);return env;
}
function feed(env,count=6,amp=.1){
  for(let j=0;j<count;j++){env.clock.tick(8192/44100*1000);env.emit('FrameRecorded',{frameBuffer:pcm(tone(1000,44100,8192,amp,2*Math.PI*1000*j*8192/44100)).buffer});}
}
check('Formant tracker independent reacquisition','F1 300 -> 600 Hz recovers after 3 consistent frames; F2/F3 retained',()=>{
  let frame=0;
  const env=runtime({'utils/phonetic/burg-lpc.js':{burgLPC:()=>({a:polynomial([[frame++<4?300:600,80],[1500,120],[2500,180]])})}});
  const signal=new Float64Array(300+11*120),pitchTrack=Array.from({length:12},(_,i)=>({time:(i*120+150)/12000,f0:100,aperiodicity:0}));
  const t=env.load('utils/phonetic/formant-extract.js').formantTrack(signal,12000,{pitchTrack,compareOrders:false});
  const frequencies=t.map(row=>[row.F1.freq,row.F2.freq,row.F3.freq]);
  return {ok:frequencies[4][0]===0&&frequencies[5][0]===0&&frequencies.slice(6).every(a=>a[0]===600&&a[1]===1500&&a[2]===2500),frequencies,injected:'Burg output only; real roots and tracker'};
});
check('Corrupt calibration offset invalidates metadata','All malformed/out-of-range offsets cannot retain valid calibration',()=>{
  const values=[undefined,null,'','100junk',NaN,Infinity,39,161,{},true];
  const trials=values.map(value=>{const env=runtime();env.storage.set('offset',value);env.storage.set('offsetValid',true);env.storage.set('offsetMeta',{captureProfile:'test',deviceId:'device'});const status=env.load('utils/data-model.js').getOffsetStatus({captureProfile:'test',deviceId:'device'});return {input:String(value),valid:status.valid,hasMeta:env.storage.has('offsetMeta')};});
  return {ok:trials.every(t=>!t.valid&&!t.hasMeta),trials};
});
check('Calibration identity and atomic validity','Mismatched profile/device invalid; interrupted metadata write leaves validity false',()=>{
  const env=runtime(),model=env.load('utils/data-model.js');model.setOffset(103.123456,{captureProfile:'profile',deviceId:'device'});
  const good=model.getOffsetStatus({captureProfile:'profile',deviceId:'device'}),profile=model.getOffsetStatus({captureProfile:'new',deviceId:'device'}),device=model.getOffsetStatus({captureProfile:'profile',deviceId:'new'});
  const original=env.wx.setStorageSync;env.wx.setStorageSync=(k,v)=>{if(k==='offsetMeta')throw Error('Injected storage failure');original(k,v);};
  let threw=false;try{model.setOffset(110,{captureProfile:'profile',deviceId:'device'});}catch{threw=true;}
  return {ok:good.valid&&!profile.valid&&!device.valid&&threw&&env.storage.get('offsetValid')===false,good,profile,device,writeFailure:threw};
});
check('Rough calibration cannot save before sampling','No modal or valid calibration before 88200 samples',()=>{
  const env=preparePage('pages/calibrate/calibrate.js');env.page.saveOffset();
  env.page.doRoughCalibrate({currentTarget:{dataset:{spl:80,name:'test'}}});feed(env,10);env.page.saveOffset();
  return {ok:!env.page.data.canSaveCalibration&&env.modals.length===0&&env.storage.get('offsetValid')!==true,data:env.page.data,receivedSamples:81920};
});
check('Rough calibration completes and preserves precision','88200 valid samples; known 80 dB target gives offset 103.0103 +/-0.05 dB',()=>{
  const env=preparePage('pages/calibrate/calibrate.js');env.page.doRoughCalibrate({currentTarget:{dataset:{spl:80,name:'test'}}});feed(env,11);
  const completed=env.page.completedCalibration;env.page.saveOffset();if(env.modals.length)env.modals[0].success({confirm:true});
  const stored=env.storage.get('offset');
  return {ok:!!completed&&env.page.data.canSaveCalibration&&env.storage.get('offsetValid')===true&&Math.abs(stored-103.01029995664)<.05&&stored===completed.offset,stored,completed};
});
check('Rough calibration timeout / interruption / stale modal','All three cases cannot save calibration',()=>{
  const env1=preparePage('pages/calibrate/calibrate.js');env1.page.doRoughCalibrate({currentTarget:{dataset:{spl:80,name:'test'}}});feed(env1,2);env1.clock.tick(3501);env1.page.saveOffset();
  const env2=preparePage('pages/calibrate/calibrate.js');env2.page.doRoughCalibrate({currentTarget:{dataset:{spl:80,name:'test'}}});feed(env2,2);env2.emit('InterruptionBegin',{});feed(env2,11);env2.page.saveOffset();
  const env3=preparePage('pages/calibrate/calibrate.js');env3.page.doRoughCalibrate({currentTarget:{dataset:{spl:80,name:'test'}}});feed(env3,11);env3.page.saveOffset();const modal=env3.modals[0];env3.page.onHide();if(modal)modal.success({confirm:true});
  return {ok:[env1,env2,env3].every(e=>e.storage.get('offsetValid')!==true&&!e.page.data.canSaveCalibration)&&env1.modals.length===0&&env2.modals.length===0&&!!modal,timeout:env1.page.data,interruption:env2.page.data,staleModalOpened:!!modal};
});
check('Main valid tone through real energy pipeline','Known 1 kHz input: CNE +/-0.05 dB, actual sample duration, save allowed',()=>{
  const env=preparePage('pages/main/main.js',true);feed(env);const archive=env.page.archive();env.page.saveResult();
  const expected=100+20*Math.log10(.1/Math.sqrt(2))+10*Math.log10(2/8);
  return {ok:archive.dataQuality==='valid'&&Math.abs(archive.cne-expected)<.05&&Math.abs(Number(archive.duration)-49152/44100)<.001&&env.saved.length===1,archive,expected,saved:env.saved.length};
});
check('Main stops receiving frames','After <=2250 ms stale UI cleared, archive invalid, save blocked; resumed frame does not revive session',()=>{
  const env=preparePage('pages/main/main.js',true);feed(env);const before=env.page.archive();env.clock.tick(2250);const stale={...env.page.data};env.page.saveResult();const archive=env.page.archive();feed(env,1);
  return {ok:before.dataQuality==='valid'&&['dbfs','dbspl','cne'].every(k=>stale[k]==='--')&&archive.dataQuality==='invalid'&&env.saved.length===0&&env.page.archive().dataQuality==='invalid',beforeCne:before.cne,stale,archive,saved:env.saved.length};
});
check('Main constant PCM / digital silence / overload','All invalidate measurement and prevent saving',()=>{
  const inputs=[new Int16Array(8192).fill(1234),new Int16Array(8192),pcm(tone(1000,44100,8192,.99))];
  const trials=inputs.map(buffer=>{const env=preparePage('pages/main/main.js',true);feed(env);env.emit('FrameRecorded',{frameBuffer:buffer.buffer});env.page.saveResult();return {quality:env.page.archive().dataQuality,cne:env.page.data.cne,saved:env.saved.length};});
  return {ok:trials.every(t=>t.quality==='invalid'&&t.cne==='--'&&t.saved===0),trials};
});
check('Main never gets usable input / uncalibrated','No safe numeric result or successful save',()=>{
  const empty=preparePage('pages/main/main.js',true);empty.clock.tick(2250);empty.page.saveResult();
  const uncalibrated=preparePage('pages/main/main.js');feed(uncalibrated);uncalibrated.page.saveResult();
  return {ok:[empty,uncalibrated].every(e=>e.page.data.cne==='--'&&e.saved.length===0&&e.page.archive().dataQuality==='invalid'),empty:empty.page.data,uncalibrated:uncalibrated.page.data};
});
check('Main stop and restart clears timer/session','No timer/listener after hiding; new session begins empty and can recover',()=>{
  const env=preparePage('pages/main/main.js',true);feed(env);env.page.onHide();const remainingTimers=env.timers.size;env.clock.tick(5000);env.page.onShow();const initial=env.page.archive();env.clock.tick(50);feed(env);const after=env.page.archive();env.page.onHide();
  return {ok:remainingTimers===0&&initial.dataQuality==='invalid'&&initial.duration==='0.000'&&after.dataQuality==='valid'&&env.timers.size===0,remainingTimers,initialDuration:initial.duration,afterQuality:after.dataQuality};
});

check('DC rejection and 25 Hz preservation','Constant PCM -> zero; settled 25 Hz attenuation < 0.05 dB; chunk invariant',()=>{
  const constant=new DCBlocker(44100).process(new Int16Array(10000).fill(2000));
  const x=pcm(tone(25,44100,88200)),whole=new DCBlocker(44100).process(x),filter=new DCBlocker(44100),parts=[];
  for(let i=0;i<x.length;i+=8192)parts.push(...filter.process(x.slice(i,i+8192)));
  const gainDb=20*Math.log10(rms(whole.slice(44100))/(.1/Math.sqrt(2)));let maxError=0;for(let i=0;i<whole.length;i++)maxError=Math.max(maxError,Math.abs(whole[i]-parts[i]));
  return {ok:constant.every(x=>x===0)&&Math.abs(gainDb)<.05&&maxError===0,gainDb,maxError};
});

check('Rough calibration rejects DC step after warmup','Constant PCM after an input DC shift must not produce a valid calibration',()=>{
  const env=preparePage('pages/calibrate/calibrate.js');feed(env,2);
  env.page.doRoughCalibrate({currentTarget:{dataset:{spl:80,name:'test'}}});
  for(let i=0;i<11;i++){env.clock.tick(8192/44100*1000);env.emit('FrameRecorded',{frameBuffer:new Int16Array(8192).fill(6000).buffer});}
  env.page.saveOffset();if(env.modals.length)env.modals[0].success({confirm:true});
  const completed=env.page.completedCalibration,offsetValid=env.storage.get('offsetValid'),canSave=env.page.data.canSaveCalibration;
  env.page.onHide();env.load('pages/main/main.js');env.page.onShow();env.clock.tick(50);feed(env);
  const subsequent=env.page.archive(),referenceCne=100+20*Math.log10(.1/Math.sqrt(2))+10*Math.log10(2/8);
  return {ok:!canSave&&offsetValid!==true,completed,offsetValid,pcmQuality:inspectPcm(new Int16Array(8192).fill(6000)),subsequentCne:subsequent.cne,subsequentQuality:subsequent.dataQuality,subsequentThreat:subsequent.threat,referenceOffset:100,referenceCne,cneBiasForReferenceOffset100:subsequent.cne===null?null:subsequent.cne-referenceCne};
});
for(const f0 of [100,200,400])check(`44.1 kHz PCM vowel pipeline F0=${f0}`,'Resolvable formants within 10% and >=80% coverage; F1 below 1.5*F0 is missing',()=>{
  const rate=44100,n=rate,poles=[[500,80],[1500,120],[2500,180],[3500,220],[4500,300]];
  // Band-limited periodic excitation avoids pulse-time rounding at noninteger periods.
  let source=new Float64Array(n);
  for(let k=1;k*f0<rate/2;k++)for(let i=0;i<n;i++)source[i]+=Math.cos(2*Math.PI*k*f0*i/rate);
  // Cascade second-order resonators for numerical stability of the reference generator.
  for(const pole of poles)source=allPole(source,polynomial([pole],rate));
  const tilted=new Float64Array(n);for(let i=0;i<n;i++)tilted[i]=source[i]+(i?.99*tilted[i-1]:0);
  const peak=tilted.reduce((p,x)=>Math.max(p,Math.abs(x)),0),raw=pcm(tilted.map(x=>x*.4/peak));
  const analysis=resampleLowPass(centeredSignal(raw),44100,12000,5500);
  const pitch=yinPitchTrack(analysis,12000,{frameSize:1024,hopSize:120,threshold:.1,fmin:40,fmax:1200});
  const tracks=formantTrack(emphasizeFloat(analysis),12000,{pitchTrack:pitch}).filter(row=>row.time>=.1&&row.time<=.9);
  const slots=['F1','F2','F3'].map((key,i)=>{const a=tracks.map(row=>row[key].freq).filter(x=>x>0).sort((a,b)=>a-b),median=a.length?a[Math.floor(a.length/2)]:null;return {median,coverage:a.length/tracks.length,relativeError:median===null?null:Math.abs(median-poles[i][0])/poles[i][0]};});
  const middle=emphasizeFloat(analysis).slice(6000,6300).map((v,i)=>v*(.54-.46*Math.cos(2*Math.PI*i/299)));
  const f1ExpectedMissing = poles[0][0] < 1.5 * f0;
  const f1Ok = f1ExpectedMissing ? slots[0].coverage===0 : slots[0].coverage>=.8&&slots[0].relativeError<=.1;
  return {ok:f1Ok&&slots.slice(1).every(s=>s.coverage>=.8&&s.relativeError<=.1),slots,f1ExpectedMissing,clipped:inspectPcm(raw).clipped,middleFrameCandidates:extractFormants(middle,12,12000)._candidates};
});
check('LTAS actual page PSD normalization','Integral of PSD equals known sine power within 0.01 dB',()=>{
  const env=runtime({},(file,code)=>{
    if(file!=='pages/phonetic/phonetic.js')return code;
    // Read-only in-memory instrumentation: expose result AFTER production PSD calculation.
    const marker='dbMax = Math.ceil(dbMax / 10) * 10;';
    if(code.split(marker).length!==2)throw Error('LTAS capture marker changed');
    return code.replace(marker,'globalThis.__ltas = {avgDb: Array.from(avgDb),sampleRate,fftSize,frameCount};'+marker)
      +'\nmodule.exports.__setTestResult=(page,result)=>{analysisResult=result;currentPhoneticPage=page;};';
  });
  const module=env.load('pages/phonetic/phonetic.js'),page=env.page;
  module.__setTestResult(page,{signal:tone(1000,44100,44100),duration:1});
  page._ltasCtx=new Proxy({},{get:()=>()=>{}});page._ltasW=600;page._ltasH=300;page.initLTASCanvas=callback=>callback();page.drawLTAS();
  const capture=env.context.__ltas,actual=db(capture.avgDb.reduce((s,x)=>s+10**(x/10),0)*capture.sampleRate/capture.fftSize),expected=20*Math.log10(.1/Math.sqrt(2));
  return {ok:Math.abs(actual-expected)<.01,actual,expected,error:actual-expected,frameCount:capture.frameCount,instrumentation:'In-memory state injection/output observation only; original PSD and FFT run unchanged'};
});

// Explanatory diagnostics do not change pass/fail gates or production algorithms.
const diagnostics={};
diagnostics.pitchUpperBoundary=Array.from({length:21},(_,i)=>1185+i).map(f=>({inputHz:f,configured:yinPitchFrame(tone(f,12000,1024),12000,.1,40,1200),widerRange:yinPitchFrame(tone(f,12000,1024),12000,.1,40,1400)}));
diagnostics.vowelCandidates=[100,200,400].map(f0=>{
  const x=allPole(Float64Array.from({length:12000},(_,i)=>i%(12000/f0)===0?1:0),polynomial([[500,80],[1500,120],[2500,180]]));
  const frame=x.slice(6000,6300).map((v,i)=>v*(.54-.46*Math.cos(2*Math.PI*i/299)));
  return {f0,extraction:extractFormants(frame,12,12000)};
});
diagnostics.subFullScaleClipping=inspectPcm(pcm(tone(100,44100,8192,.8).map(x=>Math.max(-.3,Math.min(.3,x)))));
function finish() {
  const files=['utils/phonetic/yin-pitch.js','utils/phonetic/formant-extract.js','utils/phonetic/burg-lpc.js','utils/phonetic/poly-roots.js','utils/phonetic/harmonicity.js','utils/phonetic/resample.js','utils/phonetic/voice-metrics.js','utils/phonetic/frame-segment.js','utils/phonetic/phonetic-config.js','utils/audio-math.js','utils/fft.js','utils/audio-quality.js','utils/calibration-quality.js','utils/data-model.js','utils/canvas-spectrum.js','utils/recorder-session.js','utils/constants.js','pages/main/main.js','pages/calibrate/calibrate.js','pages/phonetic/phonetic.js','tests/algorithm-evaluation.cjs','tests/runtime.cjs','utils/phonetic/analysis.js','utils/phonetic/iteration.js','utils/measurement-version.js'];
  const report={generatedAt:new Date().toISOString(),runtime:process.version,platform:process.platform,criteria:'Engineering synthetic-signal evaluation; not clinical or device certification',sourceSha256:Object.fromEntries(files.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex')])),summary:{total:results.length,passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length,errors:results.filter(r=>r.status==='ERROR').length},results};
  report.diagnostics=diagnostics;
  fs.writeFileSync(path.join(root,'docs/algorithm-evaluation-results.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report.summary));
  for(const r of results.filter(r=>r.status!=='PASS'))console.log(JSON.stringify(r));
  process.exitCode=report.summary.failed||report.summary.errors?1:0;
}
finish();
