import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {createBridge,writeConfig,bridgeDir} from './core.js'
function setup(role) {
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-sync-test-'))
 fs.mkdirSync(path.join(home,'profiles','desktop'),{recursive:true})
 fs.writeFileSync(path.join(home,'profiles','desktop','cordis.patch.yml'),'- id: theme\n  config:\n    color: dark\n')
 fs.writeFileSync(path.join(home,'profiles','desktop','package.json'), JSON.stringify({dependencies:{'demo-plugin':'1.2.3','@deepseek-ai/dsh-base':'0.2.1'}}))
 writeConfig(home,{enabled:true,role,repo:'alice/private',channel:'testchannel',token:'test-only-token',passphrase:'correct horse battery staple',includeHomePatch:false,autoApply:true,intervalSeconds:90})
 return home
}
function getTransport(){
 let content=null, sha=null
 return {get: async () => content ? {content,sha} : null,
   put: async (key, next, previous)=> {assert.equal(previous??null,sha);content=next;sha=crypto.createHash('sha1').update(content).digest('hex');return {sha}},
   inspect:()=>content
 }
}
test('encrypted snapshot publisher -> subscriber, safe initial apply, backgrounds',async()=>{
 const publisher=setup('publisher'),subscriber=setup('subscriber'),remote=getTransport()
 try {
  const source=createBridge({home:publisher,remote}),target=createBridge({home:subscriber,remote})
  const a=await source.sync();assert.equal(a.state,'published')
  assert.doesNotMatch(remote.inspect(),/color: dark/)
  const b=await target.sync();assert.equal(b.state,'downloaded-needs-approval')
  // Distinct local config requires explicit confirmation; no silent overwrite.
  fs.writeFileSync(path.join(subscriber,'profiles','desktop','cordis.patch.yml'),'different user profile')
  const c=target.apply();assert.equal(c.conflicts.length,1)
  const d=target.apply({force:true});assert.equal(d.conflicts.length,0)
  assert.match(fs.readFileSync(path.join(subscriber,'profiles','desktop','cordis.patch.yml'),'utf8'),/color: dark/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(bridgeDir(subscriber),'desired-plugins.json'),'utf8'))['demo-plugin'],'1.2.3')
  fs.writeFileSync(path.join(publisher,'profiles','desktop','cordis.patch.yml'),'hello: new\n')
  assert.equal((await source.sync()).state,'published')
  assert.equal((await target.sync()).state,'downloaded-and-applied')
  assert.equal(fs.readFileSync(path.join(subscriber,'profiles','desktop','cordis.patch.yml'),'utf8'),'hello: new\n')
 } finally {fs.rmSync(publisher,{recursive:true,force:true});fs.rmSync(subscriber,{recursive:true,force:true})}
})
test('local divergence is not overwritten by newer remote content',async()=>{
 const publisher=setup('publisher'),subscriber=setup('subscriber'),remote=getTransport()
 try {
  const source=createBridge({home:publisher,remote}),target=createBridge({home:subscriber,remote})
  await source.sync(); await target.sync();target.apply({force:true})
  fs.writeFileSync(path.join(subscriber,'profiles','desktop','cordis.patch.yml'),'my local unsaved changes')
  fs.writeFileSync(path.join(publisher,'profiles','desktop','cordis.patch.yml'),'different remote changes')
  await source.sync()
  const result=await target.sync()
  assert.equal(result.conflicts.length,1)
  assert.equal(fs.readFileSync(path.join(subscriber,'profiles','desktop','cordis.patch.yml'),'utf8'),'my local unsaved changes')
 } finally {fs.rmSync(publisher,{recursive:true,force:true});fs.rmSync(subscriber,{recursive:true,force:true})}
})
