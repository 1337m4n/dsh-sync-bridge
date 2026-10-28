import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {createBridge,writeConfig,bridgeDir,buildSnapshot,applyInbox,readConfig,GithubContents} from './core.js'
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

const profile='profiles/desktop/cordis.patch.yml'
const fixture=files=>({schema:1,files,plugins:{'demo-plugin':'1.2.3'}})
const encoded=value=>Buffer.from(value).toString('base64')
function inbox(home,data) {fs.writeFileSync(path.join(bridgeDir(home),'inbox.json'),JSON.stringify(data))}
function cleanup(...homes) {for(const home of homes) fs.rmSync(home,{recursive:true,force:true})}

test('large GitHub file uses repository Git Blobs route, not contents/git/blobs',async t=>{
 const calls=[]
 t.mock.method(globalThis,'fetch',async (url,options)=>{
  calls.push([url,options])
  return Response.json(calls.length===1 ? {type:'file',sha:'a'.repeat(40),size:1024*1024+1,encoding:'none',content:''} : {encoding:'base64',content:encoded('encrypted-test-snapshot')})
 })
 const result=await new GithubContents('alice/private','mock-token').get('dsh-sync-bridge/test/snapshot.json')
 assert.equal(result.content,'encrypted-test-snapshot')
 assert.deepEqual(calls.map(([url])=>url),[
  'https://api.github.com/repos/alice/private/contents/dsh-sync-bridge/test/snapshot.json',
  'https://api.github.com/repos/alice/private/git/blobs/'+ 'a'.repeat(40)])
 assert.equal(calls[0][1].redirect,'error')
 assert.ok(calls[0][1].signal instanceof AbortSignal)
})
test('public runtime repository is rejected before any snapshot request',async t=>{
 const home=setup('publisher');let requests=0
 t.mock.method(globalThis,'fetch',async url=>{requests++;assert.equal(url,'https://api.github.com/repos/alice/private');return Response.json({private:false})})
 try {await assert.rejects(createBridge({home}).sync(),/must be private/);assert.equal(requests,1)} finally {cleanup(home)}
})
test('GitHub GET missing contents differs from denied repository/blob access',async t=>{
 t.mock.method(globalThis,'fetch',async()=>new Response('',{status:404}))
 const api=new GithubContents('alice/private','mock-token')
 assert.equal(await api.get('missing'),null)
 await assert.rejects(api.verifyPrivate(),/HTTP 404/)
 await assert.rejects(api.request('GET','git/blobs/missing'),/HTTP 404/)
})
test('GitHub rate limits enter cooldown without leaking response bodies',async t=>{
 let requests=0
 t.mock.method(globalThis,'fetch',async()=>{requests++;return new Response('sensitive-error-detail',{status:403,headers:{'x-ratelimit-remaining':'0','retry-after':'120'}})})
 const api=new GithubContents('alice/private','mock-token')
 await assert.rejects(api.get('test'),/rate limited/)
 await assert.rejects(api.get('test'),/cooldown/)
 assert.equal(requests,1)
 assert.ok(api.retryAt>=Date.now()+110000)
})
test('HTTP failures and oversized responses are bounded and sanitized',async t=>{
 const api=new GithubContents('alice/private','mock-token')
 const mocked=t.mock.method(globalThis,'fetch',async()=>new Response('secret-error',{status:401}))
 await assert.rejects(api.verifyPrivate(),error=>error.message==='GitHub GET: HTTP 401')
 mocked.mock.mockImplementation(async()=>new Response('x'.repeat(25*1024*1024)))
 await assert.rejects(api.verifyPrivate(),/Oversized GitHub response/)
})
test('invalid initialization preserves the previous local credentials',()=>{
 const home=setup('publisher')
 try {const before=fs.readFileSync(path.join(bridgeDir(home),'local.json'),'utf8');assert.throws(()=>writeConfig(home,{...readConfig(home),repo:'bad'}),/owner\/name/);assert.equal(fs.readFileSync(path.join(bridgeDir(home),'local.json'),'utf8'),before)} finally {cleanup(home)}
})
test('all incoming paths and values are validated before any file is changed',async t=>{
 const bad=[
  fixture({[profile]:encoded('changed'),'../escape.json':encoded('bad')}),
  fixture({[profile]:encoded('changed'),'sync-bridge-assets/C:/test.json':encoded('bad')}),
  fixture({[profile]:encoded('changed'),'sync-bridge-assets/NUL.json':encoded('bad')}),
  fixture({[profile]:encoded('changed'),'sync-bridge-assets/node_modules/secret.json':encoded('bad')}),
  fixture({[profile]:encoded('changed'),'sync-bridge-assets/test.json.':encoded('bad')}),
  fixture({[profile]:encoded('changed'),'sync-bridge-assets/UP.json':'!!!!'}),
  fixture({[profile]:encoded('changed'),'sync-bridge-assets/UP.json':123}),
  fixture({'sync-bridge-assets/a.json':'','sync-bridge-assets/A.json':''}),
  fixture({'sync-bridge-assets/a.json':'','sync-bridge-assets/a.json/child.json':''}),
  {schema:1,files:[],plugins:{}},
  {schema:2,files:{},plugins:{}},
  {schema:1,files:{[profile]:encoded('changed')},plugins:{'malicious':'https://user:secret@example.test/repo'}},
  fixture({'sync-bridge-assets/large.json':encoded(Buffer.alloc(3*1024*1024+1))}),
  fixture(Object.fromEntries(Array.from({length:513},(_,i)=>['sync-bridge-assets/'+i+'.json','']))),
  fixture(Object.fromEntries(Array.from({length:3},(_,i)=>['sync-bridge-assets/'+i+'.json',encoded(Buffer.alloc(3*1024*1024))])))
 ]
 for(const [i,data] of bad.entries()) await t.test('reject invalid snapshot '+(i+1),()=>{
  const home=setup('subscriber')
  try {const before=fs.readFileSync(path.join(home,profile),'utf8');inbox(home,data);assert.throws(()=>applyInbox(home,readConfig(home),{force:true}));assert.equal(fs.readFileSync(path.join(home,profile),'utf8'),before);assert.equal(fs.existsSync(path.join(bridgeDir(home),'desired-plugins.json')),false)} finally {cleanup(home)}
 })
})
test('source rejects symlinked profile/asset roots and omits unsafe dependencies',()=>{
 const home=setup('publisher'),outside=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-sync-outside-'))
 try {
  fs.writeFileSync(path.join(outside,'secret.json'),'private')
  fs.symlinkSync(outside,path.join(home,'sync-bridge-assets'),process.platform==='win32'?'junction':'dir')
  assert.throws(()=>buildSnapshot(home,readConfig(home)),/symlink/)
  fs.unlinkSync(path.join(home,'sync-bridge-assets'))
  fs.mkdirSync(path.join(home,'sync-bridge-assets','node_modules'),{recursive:true})
  fs.writeFileSync(path.join(home,'sync-bridge-assets','node_modules','package.json'),'not-for-sync')
  assert.deepEqual(Object.keys(buildSnapshot(home,readConfig(home)).files),[profile])
  const pkg=path.join(home,'profiles','desktop','package.json')
  fs.writeFileSync(pkg,JSON.stringify({dependencies:{'demo-plugin':'^1.2.3','local-plugin':'link:/private/location','remote-plugin':'git+https://token@example.test/repo','@deepseek-ai/core':'1.0.0'}}))
  assert.deepEqual(buildSnapshot(home,readConfig(home)).plugins,{'demo-plugin':'^1.2.3'})
  fs.rmSync(path.join(home,'profiles','desktop'),{recursive:true})
  fs.symlinkSync(outside,path.join(home,'profiles','desktop'),process.platform==='win32'?'junction':'dir')
  fs.writeFileSync(path.join(outside,'cordis.patch.yml'),'secret: data')
  assert.throws(()=>buildSnapshot(home,readConfig(home)),/symlink/)
 } finally {cleanup(home,outside)}
})
test('subscriber refuses symlink targets including dangling links',()=>{
 const home=setup('subscriber'),outside=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-sync-outside-'))
 try {
  const target=path.join(home,profile)
  fs.unlinkSync(target)
  // Directory junctions work on Windows without Developer Mode; test target file links on Unix too.
  fs.rmSync(path.join(home,'profiles','desktop'),{recursive:true})
  fs.symlinkSync(outside,path.join(home,'profiles','desktop'),process.platform==='win32'?'junction':'dir')
  inbox(home,fixture({[profile]:encoded('incoming')}))
  assert.equal(createBridge({home}).apply({force:true}).conflicts[0].reason,'symlink path')
  assert.equal(fs.existsSync(path.join(outside,'cordis.patch.yml')),false)
  if(process.platform!=='win32') {
   fs.unlinkSync(path.join(home,'profiles','desktop'))
   fs.mkdirSync(path.join(home,'profiles','desktop'))
   fs.symlinkSync(path.join(outside,'missing'),target)
   assert.equal(createBridge({home}).apply({force:true}).conflicts[0].reason,'symlink path')
   assert.equal(fs.existsSync(path.join(outside,'missing')),false)
  }
 } finally {cleanup(home,outside)}
})
test('state and inbox writes cannot escape through a symlinked bridge directory',()=>{
 const home=setup('subscriber'),outside=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-sync-outside-'))
 try {fs.rmSync(bridgeDir(home),{recursive:true});fs.symlinkSync(outside,bridgeDir(home),process.platform==='win32'?'junction':'dir');assert.throws(()=>writeConfig(home,{role:'subscriber',repo:'alice/private',channel:'test',token:'mock',passphrase:'a long test passphrase'}),/symlink/);assert.deepEqual(fs.readdirSync(outside),[])} finally {cleanup(home,outside)}
})
test('conflicts remain pending, explicit force backs up local edits',async()=>{
 const home=setup('subscriber')
 try {
  inbox(home,fixture({[profile]:encoded('incoming')}))
  const bridge=createBridge({home})
  assert.equal(bridge.apply().conflicts.length,1)
  assert.equal(bridge.status().inboxPending,true)
  assert.equal(bridge.apply({force:true}).conflicts.length,0)
  fs.writeFileSync(path.join(home,profile),'local editing')
  inbox(home,fixture({[profile]:encoded('next version')}))
  assert.equal(bridge.apply().conflicts.length,1)
  assert.equal(bridge.status().inboxPending,true)
  assert.equal(bridge.apply({force:true}).conflicts.length,0)
  const backups=fs.readdirSync(path.join(bridgeDir(home),'backups'))
  assert.equal(backups.length,2)
  if(process.platform!=='win32') for(const name of backups) assert.equal(fs.statSync(path.join(bridgeDir(home),'backups',name,profile)).mode&0o777,0o600)
 } finally {cleanup(home)}
})
test('missing inbox and interrupted auto-apply recover on an unchanged remote SHA',async()=>{
 const publisher=setup('publisher'),subscriber=setup('subscriber'),remote=getTransport()
 try {
  const source=createBridge({home:publisher,remote}),target=createBridge({home:subscriber,remote})
  await source.sync();await target.sync();target.apply({force:true})
  fs.unlinkSync(path.join(bridgeDir(subscriber),'inbox.json'))
  assert.equal((await target.sync()).state,'downloaded-and-applied')
  fs.writeFileSync(path.join(publisher,profile),'new remote content');await source.sync()
  const cfg=readConfig(subscriber)
  writeConfig(subscriber,{...cfg,autoApply:false})
  await createBridge({home:subscriber,remote}).sync()
  writeConfig(subscriber,cfg)
  assert.equal((await createBridge({home:subscriber,remote}).sync()).state,'downloaded-and-applied')
  assert.equal(fs.readFileSync(path.join(subscriber,profile),'utf8'),'new remote content')
 } finally {cleanup(publisher,subscriber)}
})
test('changing channel revokes first-import approval and old apply hashes',async()=>{
 const publisher=setup('publisher'),subscriber=setup('subscriber'),remote=getTransport()
 try {
  await createBridge({home:publisher,remote}).sync()
  const target=createBridge({home:subscriber,remote});await target.sync();target.apply({force:true})
  writeConfig(subscriber,{...readConfig(subscriber),channel:'different-channel'})
  const next=createBridge({home:subscriber,remote})
  assert.equal(next.status().approved,false)
  assert.equal(next.status().inboxPending,false)
  assert.throws(()=>next.apply({force:true}),/another configuration/)
 } finally {cleanup(publisher,subscriber)}
})
test('wrong passphrase and tampered ciphertext never create an inbox or overwrite remote data',async()=>{
 const publisher=setup('publisher'),subscriber=setup('subscriber'),remote=getTransport()
 try {
  await createBridge({home:publisher,remote}).sync()
  const original=remote.inspect()
  writeConfig(subscriber,{...readConfig(subscriber),passphrase:'incorrect long test passphrase'})
  await assert.rejects(createBridge({home:subscriber,remote}).sync())
  assert.equal(fs.existsSync(path.join(bridgeDir(subscriber),'inbox.json')),false)
  writeConfig(publisher,{...readConfig(publisher),passphrase:'incorrect long test passphrase'})
  await assert.rejects(createBridge({home:publisher,remote}).sync(),/refusing overwrite/)
  assert.equal(remote.inspect(),original)
  const blob=JSON.parse(original);blob.tag=encoded(Buffer.alloc(16))
  const badRemote={get:async()=>({sha:'tampered',content:JSON.stringify(blob)})}
  await assert.rejects(createBridge({home:subscriber,remote:badRemote}).sync())
 } finally {cleanup(publisher,subscriber)}
})

test('plugin is inert without init and disposes both background timers',async t=>{
 const {apply}=await import('./index.js')
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-sync-plugin-'))
 const previous=process.env.DSH_HOME
 process.env.DSH_HOME=home
 let effect,interval,startup;const cleared=[]
 t.mock.method(globalThis,'setInterval',(fn,delay)=>{interval={fn,delay};return 'interval'})
 t.mock.method(globalThis,'setTimeout',(fn,delay)=>{startup={fn,delay};return 'startup'})
 t.mock.method(globalThis,'clearInterval',id=>cleared.push(id))
 t.mock.method(globalThis,'clearTimeout',id=>cleared.push(id))
 try {
  apply({effect:()=>assert.fail('must be inert before init')})
  writeConfig(home,{enabled:true,role:'publisher',repo:'alice/private',channel:'test',token:'mock-token',passphrase:'test long passphrase',intervalSeconds:90})
  apply({effect:fn=>{effect=fn()}})
  assert.equal(interval.delay,90000);assert.equal(startup.delay,8000)
  effect();assert.deepEqual(cleared,['interval','startup'])
 } finally {if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;cleanup(home)}
})

// Regression: cli.mjs used node:readline/promises' question(), which resolves ''
// on piped stdin, so `cli.mjs init` answered by a pipe or a script wrote empty
// credentials (or exited 13 on unsettled top-level await). Piped input must run
// the same wizard as a terminal and persist every answer.
test('cli init accepts piped answers for every prompt including masked secrets',async()=>{
 const {spawn}=await import('node:child_process')
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-sync-cli-'))
 const run=(answers,gap)=>new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,[path.join(path.dirname(new URL(import.meta.url).pathname),'cli.mjs'),'init'],{env:{...process.env,DSH_HOME:home},stdio:['pipe','pipe','pipe']})
   let out=''
   child.stdout.on('data',(chunk)=>{out+=chunk})
   child.stderr.on('data',(chunk)=>{out+=chunk})
   child.on('error',reject)
   child.stdin.on('error',()=>{})
   const queue=[...answers]
   const timer=setInterval(()=>{
     if(!queue.length){clearInterval(timer);child.stdin.end();return}
     child.stdin.write(queue.shift()+'\n')
   },gap)
   child.on('exit',(code)=>{clearInterval(timer);resolve({code,out})})
 })
 try {
   const answers=['subscriber','alice/private','piped-channel','piped-token','piped passphrase 123','YES','YES']
   // 0ms floods the pipe (reader drains ahead of the questions), 150ms arrives
   // prompt by prompt; both paths must agree.
   for (const gap of [0,150]) {
     fs.rmSync(path.join(home,'sync-bridge'),{recursive:true,force:true})
     const {code,out}=await run(answers,gap)
     assert.equal(code,0,`gap ${gap}: ${out}`)
     assert.match(out,/Saved local-only configuration/)
     const saved=readConfig(home)
     assert.equal(saved.role,'subscriber')
     assert.equal(saved.repo,'alice/private')
     assert.equal(saved.channel,'piped-channel')
     assert.equal(saved.token,'piped-token')
     assert.equal(saved.passphrase,'piped passphrase 123')
     assert.equal(saved.includeHomePatch,true)
     assert.equal(saved.autoApply,true)
   }
 } finally {fs.rmSync(home,{recursive:true,force:true})}
})
