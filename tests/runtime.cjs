'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const { computeThirdOctaveBands } = require('../utils/canvas-spectrum');
function runtime(overrides={}, transform=(file,code)=>code, recorderOptions={}) {
  let now=100000,nextTimer=1;
  const timers=new Map(),storage=new Map(),events=new Map(),modals=[],toasts=[],saved=[],logs=[];
  const schedule=(fn,delay,interval=0)=>{const id=nextTimer++;timers.set(id,{fn,at:now+delay,interval});return id;};
  const clock={tick(ms){const end=now+ms;let iterations=0;while(true){let pair=null;for(const entry of timers)if(entry[1].at<=end&&(!pair||entry[1].at<pair[1].at))pair=entry;if(!pair)break;if(++iterations>10000)throw Error('Fake timer loop');const [id,t]=pair;now=t.at;if(t.interval)t.at+=t.interval;else timers.delete(id);t.fn();}now=end;}};
  const emit=(name,arg)=>{for(const fn of [...(events.get(name)||[])])fn(arg);};
  const recorder={running:false,starts:0,startedAt:null,
    start(){this.running=true;this.startedAt=now;this.starts++;emit('Start',{});},
    stop(){if(this.running){this.running=false;emit('Stop',{duration:Math.round(now-this.startedAt)});}}};
  for(const name of ['Start','Stop','FrameRecorded','InterruptionBegin','InterruptionEnd','Pause','Resume','Error']){
    recorder['on'+name]=fn=>{if(!events.has(name)||recorderOptions.singleListener)events.set(name,new Set());events.get(name).add(fn);};
    recorder['off'+name]=fn=>{if(events.has(name))events.get(name).delete(fn);};
    if(recorderOptions.noOff)delete recorder['off'+name];
  }
  const noop=()=>{};
  const wx={getRecorderManager:()=>recorder,getStorageSync:key=>storage.has(key)?storage.get(key):'',setStorageSync:(key,value)=>storage.set(key,value),removeStorageSync:key=>storage.delete(key),getDeviceInfo:()=>({brand:'Test',model:'Device',platform:'android',system:'mock'}),createWebAudioContext:()=>({close:noop}),showModal:opts=>modals.push(opts),showToast:opts=>toasts.push(opts),showLoading:noop,hideLoading:noop,navigateBack:noop,vibrateLong:noop,nextTick:fn=>fn()};
  const canvas=new Proxy({computeThirdOctaveBands,recordArrayPoint:(array,t,db)=>{array[t]=db;}},{get:(obj,key)=>obj[key]||noop});
  const mocks={'utils/canvas/index.js':canvas,'utils/result-manager.js':{add:r=>{saved.push(r);return r;}},...overrides};
  let page;
  class FakeDate extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const context=vm.createContext({wx,getApp:()=>({globalData:{vstamp:'test'}}),Page:definition=>{page={...definition,data:{...definition.data},setData(update,cb){Object.assign(this.data,update);if(cb)cb();}};},Date:FakeDate,console:new Proxy({},{get:()=> (...args)=>logs.push(args)}),setTimeout:(f,d=0)=>schedule(f,d),clearTimeout:id=>timers.delete(id),setInterval:(f,d)=>schedule(f,d,d),clearInterval:id=>timers.delete(id)});
  const cache=new Map();
  function requireFile(file){
    let absolute=path.resolve(root,file);if(!path.extname(absolute))absolute+='.js';
    const relative=path.relative(root,absolute).split(path.sep).join('/');
    if(Object.hasOwn(mocks,relative))return mocks[relative];
    if(cache.has(absolute))return cache.get(absolute).exports;
    const module={exports:{}};cache.set(absolute,module);
    const code=transform(relative,fs.readFileSync(absolute,'utf8'));
    const wrapper=vm.runInContext('(function(require,module,exports){'+code+'\n})',context,{filename:absolute});
    wrapper(spec=>spec.startsWith('.')?requireFile(path.resolve(path.dirname(absolute),spec)):require(spec),module,module.exports);
    return module.exports;
  }
  return {load:requireFile,get page(){return page;},clock,storage,modals,toasts,saved,wx,emit,recorder,timers,logs,context};
}

module.exports = { runtime };
