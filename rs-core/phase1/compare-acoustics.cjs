#!/usr/bin/env node
'use strict';
const path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const isolationArgs=process.argv.includes('--repository-clean')?['--repository-clean']:[];
for(const [command,args] of [
 ['python',['tools/check_port_isolation.py',...isolationArgs]],
 ['python',['tools/compare_p0_native.py']],
 ['node',['phase1/check-unit-reference.cjs']],
]) {
 const result=spawnSync(command,args,{cwd:root,encoding:'utf8',timeout:120000,maxBuffer:64*1024*1024});
 if(result.stdout)process.stdout.write(result.stdout);
 if(result.stderr)process.stderr.write(result.stderr);
 if(result.error||result.status!==0){if(result.error)console.error(result.error);process.exit(1);}
}
