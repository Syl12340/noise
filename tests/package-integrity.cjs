'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),cp=require('node:child_process'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),{runtime}=require('./runtime.cjs');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const app=JSON.parse(read('app.json')),project=JSON.parse(read('project.config.json'));
let routes=0,bindings=0,syntaxFiles=0;
function walk(dir){return fs.readdirSync(path.join(root,dir),{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(dir+'/'+e.name):[dir+'/'+e.name]);}
for(const file of ['app.js',...walk('utils'),...walk('pages'),...walk('workers')].filter(f=>f.endsWith('.js'))){
 const checked=cp.spawnSync(process.execPath,['--check',path.join(root,file)],{encoding:'utf8'});
 assert.equal(checked.status,0,checked.stderr);syntaxFiles++;
}
for(const route of app.pages){
 for(const ext of ['js','json','wxml','wxss'])assert.ok(fs.existsSync(path.join(root,route+'.'+ext)),route+'.'+ext);
 JSON.parse(read(route+'.json'));routes++;
}
for(const item of app.tabBar.list)for(const key of ['iconPath','selectedIconPath'])assert.ok(fs.existsSync(path.join(root,item[key])),item[key]);
assert.equal(app.workers,'workers');assert.ok(!Object.hasOwn(project,'workers'));
for(const name of ['tests','scripts','docs','.git','.claude','.vscode','source_code.txt','extract_code.js','fix_comments.js'])
 assert.ok(project.packOptions.ignore.some(item=>item.value===name),'Missing package exclusion: '+name);
const build=cp.spawnSync(process.execPath,[path.join(root,'scripts/build-worker.cjs'),'--check'],{encoding:'utf8'});
assert.equal(build.status,0,build.stderr);
const workerRoot=path.join(root,app.workers),cache=new Map();
function workerRequire(file){
 const absolute=path.resolve(file);
 assert.ok(absolute.startsWith(workerRoot+path.sep),'Worker dependency outside worker root: '+absolute);
 if(cache.has(absolute))return cache.get(absolute).exports;
 const module={exports:{}};cache.set(absolute,module);
 const context={module,exports:module.exports,require:specifier=>{
   assert.ok(specifier.startsWith('.'));return workerRequire(path.resolve(path.dirname(absolute),specifier+'.js'));
 },worker:{onMessage:fn=>{assert.equal(typeof fn,'function');}},setTimeout,clearTimeout};
 vm.runInNewContext(fs.readFileSync(absolute,'utf8'),context,{filename:absolute});return module.exports;
}
workerRequire(path.join(workerRoot,'phonetic-analysis/index.js'));
for(const page of ['main/main','phonetic/phonetic','result/result','advanced-calibrate/advanced-calibrate','calibrate/calibrate','advanced-calibrate/calibrate/calibrate']){
 const xml=read('pages/'+page+'.wxml').replace(/<!--[\s\S]*?-->/g,''),env=runtime();env.load('pages/'+page+'.js');
 for(const m of xml.matchAll(/(?:bind|catch)(?:tap|change|input|touchstart|touchmove|touchend)="([^"]+)"/g)){
   assert.equal(typeof env.page[m[1]],'function',page+' handler '+m[1]);bindings++;
 }
 const stack=[];
 for(const m of xml.matchAll(/<\/?([a-z][a-z0-9-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*\/?\s*>/g)){
   if(m[0].startsWith('</'))assert.equal(stack.pop(),m[1],page+' closing '+m[1]);
   else if(!/\/\s*>$/.test(m[0]))stack.push(m[1]);
 }
 assert.equal(stack.length,0,page+' unclosed tags');
}
console.log(JSON.stringify({syntaxFiles,routes,bindings,workerModules:cache.size,status:'PASS'}));
