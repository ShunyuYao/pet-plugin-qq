'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
test('local install folder includes SDK runtime dependencies and no tests or account data',async()=>{
  const root=path.resolve(__dirname,'..');
  const output=execFileSync(process.execPath,[path.join(root,'scripts/package-local.cjs')],{encoding:'utf8'}).trim();
  assert.equal(path.dirname(output),path.join(root,'dist'));
  const manifest=JSON.parse(fs.readFileSync(path.join(output,'manifest.json')));
  assert.equal(manifest.version,require('../package.json').version);
  assert.ok(fs.existsSync(path.join(output,'node_modules/ws/LICENSE')));
  assert.equal(typeof require(path.join(output,'src/onebot.cjs')).OneBot,'function');
  assert.ok(fs.existsSync(path.join(output,'node_modules/@tencent-connect/qqbot-nodejs/LICENSE')));
  const sdk=await import(require('node:url').pathToFileURL(path.join(output,'node_modules/@tencent-connect/qqbot-nodejs/dist/protocol/index.js')).href);
  assert.equal(typeof sdk.GatewayConnection,'function');assert.equal(typeof sdk.ApiClient,'function');
  for(const file of ['secrets.json','data.json','.env','tests','artifacts','.git'])assert.ok(!fs.existsSync(path.join(output,file)),file+' must not ship');
  const metadata=JSON.parse(fs.readFileSync(path.join(output,'BUILD.json')));assert.equal(metadata.published,false);assert.ok(metadata.files['panel/group.js']);
});
