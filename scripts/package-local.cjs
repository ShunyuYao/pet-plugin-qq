'use strict';
// Local folder artifact only; no publishing, host binaries or runtime data.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),manifest=require('../manifest.json');
const output=path.join(root,'dist',manifest.id+'-'+manifest.version+'-'+Date.now());
fs.mkdirSync(output,{recursive:true});
for(const file of ['manifest.json','index.cjs','src','panel'])fs.cpSync(path.join(root,file),path.join(output,file),{recursive:true});
const ws=path.dirname(require.resolve('ws/package.json'));
fs.mkdirSync(path.join(output,'node_modules'),{recursive:true});fs.cpSync(ws,path.join(output,'node_modules/ws'),{recursive:true});
const qqSDK=path.join(root,'node_modules/@tencent-connect/qqbot-nodejs');
fs.mkdirSync(path.join(output,'node_modules/@tencent-connect'),{recursive:true});
fs.cpSync(qqSDK,path.join(output,'node_modules/@tencent-connect/qqbot-nodejs'),{recursive:true});
fs.copyFileSync(path.join(root,'docs/group-feedback-quickstart.md'),path.join(output,'使用说明.md'));
const hashes={};
function hash(dir,prefix=''){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const relative=path.join(prefix,entry.name);if(entry.isDirectory())hash(path.join(dir,entry.name),relative);else hashes[relative]=crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,entry.name))).digest('hex');}}
hash(output);fs.writeFileSync(path.join(output,'BUILD.json'),JSON.stringify({version:manifest.version,developmentCandidate:true,published:false,files:hashes},null,2));
console.log(output);
