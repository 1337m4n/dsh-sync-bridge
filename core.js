import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const encoder = new TextEncoder()
const MAX_ASSET = 3 * 1024 * 1024
const MAX_TOTAL = 8 * 1024 * 1024
const MAX_FILES = 512
const MAX_REMOTE = 16 * 1024 * 1024
const SAFE_ASSETS = new Set(['.png','.jpg','.jpeg','.gif','.webp','.mp4','.webm','.css','.json','.svg'])
const allowedProfile = 'profiles/desktop/cordis.patch.yml'
const allowedHome = 'cordis.patch.yml'
const assetRoot = 'sync-bridge-assets'
const now = () => new Date().toISOString()
const sha = s => crypto.createHash('sha256').update(s).digest('hex')
const b64 = s => Buffer.from(s).toString('base64')
const unb64 = s => Buffer.from(s, 'base64')

export function getHome() { return path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh')) }
export function bridgeDir(home = getHome()) { return path.join(home, 'sync-bridge') }
export function configFile(home = getHome()) { return path.join(bridgeDir(home), 'local.json') }
export function readConfig(home = getHome()) {
  assertSafePath(home, 'sync-bridge/local.json')
  const file = configFile(home)
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
export function writeConfig(home, config) {
  validateConfig(config)
  assertSafePath(home, 'sync-bridge/local.json')
  fs.mkdirSync(bridgeDir(home), {recursive:true,mode:0o700})
  atomicWrite(configFile(home), JSON.stringify(config,null,2)+'\n')
  try { fs.chmodSync(configFile(home),0o600) } catch {}
}
function stateScope(config) { return sha(JSON.stringify([config.repo,config.channel,config.role,config.includeHomePatch,config.passphrase])) }
function loadState(home,config) {
  assertSafePath(home, 'sync-bridge/state.json')
  const p = path.join(bridgeDir(home), 'state.json')
  if(!fs.existsSync(p)) return {}
  const state=JSON.parse(fs.readFileSync(p,'utf8'))
  if(!state || typeof state!=='object' || Array.isArray(state)) throw new Error('Invalid bridge state; restore from backup')
  return state.scope===stateScope(config) ? state : {}
}
function saveState(home, value,config) {
  assertSafePath(home, 'sync-bridge/state.json')
  const p = path.join(bridgeDir(home),'state.json')
  atomicWrite(p,JSON.stringify({...value,scope:stateScope(config)},null,2)+'\n')
}
function atomicWrite(p, value) {
  fs.mkdirSync(path.dirname(p),{recursive:true,mode:0o700})
  const tmp = `${p}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp,value,{mode:0o600})
  try {fs.renameSync(tmp,p)} catch(e){try{fs.rmSync(tmp,{force:true})}catch{};throw e}
}
export function validateConfig(c) {
  if (!c || !['publisher','subscriber'].includes(c.role)) throw new Error('role must be publisher or subscriber')
  if (typeof c.repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(c.repo) || c.repo.split('/').some(part=>part==='.'||part==='..')) throw new Error('repo must be owner/name')
  if (typeof c.channel !== 'string' || !/^[a-zA-Z0-9_-]{3,50}$/.test(c.channel)) throw new Error('channel requires 3–50 ASCII letters/digits/-/_')
  for(const key of ['enabled','autoApply','includeHomePatch']) if(c[key]!==undefined && typeof c[key]!=='boolean') throw new Error(`${key} must be boolean`)
  if(c.intervalSeconds!==undefined && (!Number.isFinite(c.intervalSeconds) || c.intervalSeconds<30 || c.intervalSeconds>86400)) throw new Error('intervalSeconds must be 30–86400')
  if (typeof c.token !== 'string' || !c.token) throw new Error('GitHub token is missing')
  if (typeof c.passphrase !== 'string' || c.passphrase.length < 16) throw new Error('Passphrase must have at least 16 characters')
}
function encrypt(data, passphrase) {
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const key = crypto.scryptSync(passphrase,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024})
  const cipher = crypto.createCipheriv('aes-256-gcm',key,iv)
  cipher.setAAD(encoder.encode('dsh-sync-bridge:v1'))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data),'utf8'),cipher.final()])
  return {v:1,alg:'aes-256-gcm+scrypt',salt:b64(salt),iv:b64(iv),tag:b64(cipher.getAuthTag()),ciphertext:b64(ciphertext)}
}
function decrypt(blob, passphrase) {
  if (JSON.stringify(blob).length > MAX_REMOTE) throw new Error('Oversized encrypted snapshot')
  if (blob?.v!==1 || blob.alg!=='aes-256-gcm+scrypt') throw new Error('Unknown encrypted snapshot version')
  for (const [key, size] of [['salt',16],['iv',12],['tag',16]]) {
    if (typeof blob[key] !== 'string' || unb64(blob[key]).length !== size) throw new Error('Invalid encryption envelope')
  }
  if (typeof blob.ciphertext !== 'string') throw new Error('Invalid ciphertext')
  const key = crypto.scryptSync(passphrase,unb64(blob.salt),32,{N:32768,r:8,p:1,maxmem:64*1024*1024})
  const decipher = crypto.createDecipheriv('aes-256-gcm',key,unb64(blob.iv))
  decipher.setAAD(encoder.encode('dsh-sync-bridge:v1'))
  decipher.setAuthTag(unb64(blob.tag))
  return JSON.parse(Buffer.concat([decipher.update(unb64(blob.ciphertext)),decipher.final()]).toString('utf8'))
}
function relativeSafe(rel) {
  if (typeof rel !== 'string' || rel.startsWith('/') || rel.includes('\\')) return false
  const parts = rel.split('/')
  return rel.length <= 240 && parts.length > 0 && parts.every(p => p && p!=='.' && p!=='..' &&
    !/[<>:"|?*\x00-\x1f]/.test(p) && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))
}
function isAllowed(rel, settings) {
  if (!relativeSafe(rel)) return false
  if (rel===allowedProfile) return true
  if (rel===allowedHome) return !!settings.includeHomePatch
  return rel.startsWith(assetRoot+'/') && !rel.split('/').some(part=>part.toLowerCase()==='node_modules') && SAFE_ASSETS.has(path.extname(rel).toLowerCase())
}
function scanAssets(home, dir, out, current, budget={bytes:Object.values(out).reduce((n,v)=>n+Buffer.byteLength(v,'base64'),0),count:Object.keys(out).length}) {
  if (!fs.existsSync(dir)) return
  assertSafePath(home,path.relative(home,dir).split(path.sep).join('/'))
  for (const item of fs.readdirSync(dir,{withFileTypes:true})) {
    const full = path.join(dir,item.name)
    if (item.isSymbolicLink() || item.name.toLowerCase()==='node_modules') continue
    if (item.isDirectory()) { scanAssets(home,full,out,current,budget); continue }
    if (!item.isFile()) continue
    const rel = path.relative(home,full).split(path.sep).join('/')
    if (!isAllowed(rel,current)) continue
    const size=fs.statSync(full).size
    if(++budget.count>MAX_FILES || (budget.bytes+=size)>MAX_TOTAL) throw new Error('Snapshot entry/size limit exceeded')
    if (size > MAX_ASSET) throw new Error(`Asset exceeds 3 MiB: ${rel}`)
    out[rel] = fs.readFileSync(full).toString('base64')
  }
}
export function buildSnapshot(home, settings) {
  const files = {}
  for (const rel of [allowedProfile, ...(settings.includeHomePatch?[allowedHome]:[])]) {
    const full = path.join(home,...rel.split('/'))
    if (fs.existsSync(full)) {
      assertSafePath(home,rel)
      if (!fs.statSync(full).isFile()) throw new Error(`Not a regular file: ${rel}`)
      const size = fs.statSync(full).size
      if (size>MAX_ASSET) throw new Error(`Config exceeds 3 MiB: ${rel}`)
      files[rel] = fs.readFileSync(full).toString('base64')
    }
  }
  scanAssets(home,path.join(home,assetRoot),files,settings)
  let manifest = {}
  const profilePackage = path.join(home,'profiles','desktop','package.json')
  if (fs.existsSync(profilePackage)) {
    assertSafePath(home,'profiles/desktop/package.json')
    if(fs.statSync(profilePackage).size>MAX_ASSET) throw new Error('Oversized plugin manifest')
    const data=JSON.parse(fs.readFileSync(profilePackage,'utf8'))
    // Only package names and version specifiers; never copy executable packages, locks, or profile metadata.
    manifest = Object.fromEntries(Object.entries(data.dependencies||{}).filter(([pkg,version]) =>
      safePlugin(pkg,version)))
  }
  const snapshot = {schema:1,generatedAt:now(),files,plugins:manifest}
  validateSnapshot(snapshot,settings)
  return snapshot
}
function contentDigest(data) {
  const sorted = value => Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)))
  return sha(JSON.stringify({files:sorted(data.files),plugins:sorted(data.plugins)}))
}
function safePlugin(name,version) {
  return /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(name) &&
    !name.startsWith('@deepseek-ai/') && typeof version==='string' && version.length<=256 &&
    /^[a-zA-Z0-9~^<>=*|.+ -]+$/.test(version)
}
function validateSnapshot(data,settings) {
  const record = value => value && typeof value==='object' && !Array.isArray(value)
  if(data?.schema!==1 || !record(data.files) || !record(data.plugins)) throw new Error('Invalid remote snapshot structure')
  if(Object.keys(data.files).length>MAX_FILES || Object.keys(data.plugins).length>MAX_FILES) throw new Error('Too many snapshot entries')
  let bytes=0
  const names=new Set()
  for(const [rel,value] of Object.entries(data.files)) {
    if(!isAllowed(rel,settings)) throw new Error(`Unapproved remote path: ${rel}`)
    const lower=rel.toLowerCase()
    if(names.has(lower)) throw new Error('Case-colliding remote paths')
    names.add(lower)
    if(typeof value!=='string' || value.length>4*Math.ceil(MAX_ASSET/3) ||
      Buffer.from(value,'base64').toString('base64')!==value) throw new Error('Invalid or oversized remote item')
    if(Buffer.byteLength(value,'base64')>MAX_ASSET) throw new Error('Oversized remote item')
    bytes+=Buffer.byteLength(value,'base64')
    if(bytes>MAX_TOTAL) throw new Error('Snapshot exceeds 8 MiB; remove large assets')
  }
  for(const rel of names) {
    let parent=rel
    while(parent.includes('/')) {
      parent=parent.slice(0,parent.lastIndexOf('/'))
      if(names.has(parent)) throw new Error('Conflicting remote paths')
    }
  }
  for(const [name,version] of Object.entries(data.plugins)) if(!safePlugin(name,version)) throw new Error('Unsafe plugin manifest entry')
}
export class GithubContents {
  constructor(repo,token) { this.repo=repo;this.token=token }
  async request(method, route, payload) {
    if(Date.now() < (this.retryAt||0)) throw new Error('GitHub rate limit cooldown; retry later')
    const url=`https://api.github.com/repos/${this.repo}${route ? '/'+route : ''}`
    const res=await fetch(url,{
      method, signal:AbortSignal.timeout(30000), redirect:'error',
      headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${this.token}`,'X-GitHub-Api-Version':'2022-11-28', ...(payload?{'Content-Type':'application/json'}:{})},
      ...(payload?{body:JSON.stringify(payload)}:{})
    })
    if(res.status===404 && method==='GET' && route.startsWith('contents/')) return null
    if(!res.ok) {
      if(res.status===429 || (res.status===403 && (res.headers.get('x-ratelimit-remaining')==='0' || res.headers.has('retry-after')))) {
        const delay=Number(res.headers.get('retry-after'))*1000
        const reset=Number(res.headers.get('x-ratelimit-reset'))*1000
        this.retryAt=Math.max(Date.now()+60000, Date.now()+(delay||0), reset||0)
        throw new Error(`GitHub rate limited; retry after ${new Date(this.retryAt).toISOString()}`)
      }
      throw new Error(`GitHub ${method}: HTTP ${res.status}`)
    }
    // Bound API responses before JSON parsing, including chunked bodies.
    const chunks=[]; let bytes=0
    for await(const chunk of res.body) {
      bytes+=chunk.length
      if(bytes>MAX_REMOTE*1.5) throw new Error('Oversized GitHub response')
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  async verifyPrivate() {
    const repo=await this.request('GET','')
    if(repo?.private!==true) throw new Error('Runtime sync repository must be private')
  }
  async get(key) {
    const r=await this.request('GET',`contents/${key}`)
    if(!r) return null
    if(r.size>MAX_REMOTE) throw new Error('Oversized remote snapshot')
    if(r.type!=='file') throw new Error('Unexpected remote entry')
    // Contents API omits inline content above 1 MiB. Fetch the same Git blob instead.
    if(!/^[a-f0-9]{40}$/i.test(r.sha)) throw new Error('Invalid Git blob SHA')
    const record = r.content ? r : await this.request('GET',`git/blobs/${encodeURIComponent(r.sha)}`)
    if(record?.encoding!=='base64' || !record.content) throw new Error('GitHub returned no base64 blob content')
    return {sha:r.sha,content:Buffer.from(record.content.replace(/\s/g,''),'base64').toString('utf8')}
  }
  async put(key,content,oldSha) {
    return this.request('PUT',`contents/${key}`,{message:'Update encrypted DSH Bridge snapshot',content:b64(content),...(oldSha?{sha:oldSha}:{})})
  }
}
function remoteKey(channel) {return `dsh-sync-bridge/${channel}/snapshot.json`}
function assertSafePath(home,rel) {
  let current=path.resolve(home)
  for(const section of ['',...rel.split('/')]) {
    if(section) current=path.join(current,section)
    let stat
    try {stat=fs.lstatSync(current)} catch(error) {if(error.code==='ENOENT') continue; throw error}
    if(stat.isSymbolicLink()) throw new Error(`Unsafe symlink path: ${rel}`)
  }
}
function currentSha(home,rel) {
  const p=path.join(home,...rel.split('/'))
  return fs.existsSync(p) && fs.statSync(p).isFile() ? sha(fs.readFileSync(p)) : null
}
function saveInbox(home, snapshot,config) {
  assertSafePath(home,'sync-bridge/inbox.json')
  const inbox=path.join(bridgeDir(home),'inbox.json')
  atomicWrite(inbox, JSON.stringify({...snapshot,bridgeScope:stateScope(config)},null,2)+'\n')
}
function loadInbox(home,config) {
  assertSafePath(home,'sync-bridge/inbox.json')
  const p=path.join(bridgeDir(home),'inbox.json')
  if(!fs.existsSync(p)) throw new Error('No incoming snapshot; run sync first')
  const inbox=JSON.parse(fs.readFileSync(p,'utf8'))
  if(inbox.bridgeScope && inbox.bridgeScope!==stateScope(config)) throw new Error('Inbox belongs to another configuration; run sync first')
  return inbox
}
export function applyInbox(home, config, options={}) {
  const inbox=loadInbox(home,config)
  validateSnapshot(inbox,config)
  const state=loadState(home,config)
  const digest=contentDigest(inbox)
  const conflicts=[]
  const applied=[]
  const backupDir=path.join(bridgeDir(home),'backups',new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomBytes(4).toString('hex'))
  assertSafePath(home,'sync-bridge/desired-plugins.json')
  assertSafePath(home,'sync-bridge/backups')
  for(const rel of Object.keys(inbox.files)) {
    try {assertSafePath(home,rel)} catch {conflicts.push({path:rel,reason:'symlink path'})}
  }
  for (const [rel,base64] of Object.entries(inbox.files)) {
    const target=path.join(home,...rel.split('/'))
    if(conflicts.some(item=>item.path===rel)) continue
    if(fs.existsSync(target) && !fs.statSync(target).isFile()) {conflicts.push({path:rel,reason:'not a regular file'});continue}
    const next=Buffer.from(base64,'base64')
    const nextHash=sha(next)
    const localHash=currentSha(home,rel)
    const previous=state.appliedHashes?.[rel]
    // On the first import, require explicit --force for existing, differing files.
    const diverged= localHash && localHash!==nextHash && !options.force && (previous===undefined || localHash!==previous)
    if(diverged) {conflicts.push({path:rel,reason:'local content differs'});continue}
    if(localHash===nextHash){applied.push(rel);continue}
    if(fs.existsSync(target)) {
      const backup=path.join(backupDir,...rel.split('/'))
      fs.mkdirSync(path.dirname(backup),{recursive:true,mode:0o700})
      assertSafePath(home,path.relative(home,backup).split(path.sep).join('/'))
      fs.copyFileSync(target,backup,fs.constants.COPYFILE_EXCL)
      fs.chmodSync(backup,0o600)
    }
    atomicWrite(target,next)
    applied.push(rel)
  }
  // The package list is advisory only: never mutate desktop's package.json while running.
  atomicWrite(path.join(bridgeDir(home),'desired-plugins.json'), JSON.stringify(inbox.plugins||{},null,2)+'\n')
  state.appliedHashes = state.appliedHashes||{}
  for (const rel of applied) state.appliedHashes[rel]=currentSha(home,rel)
  state.lastAppliedAt=now()
  if(conflicts.length===0) state.lastAppliedDigest=digest
  state.conflicts=conflicts
  saveState(home,state,config)
  return {applied,conflicts,desiredPluginCount:Object.keys(inbox.plugins||{}).length}
}
export function createBridge({home=getHome(), remote}={}) {
  const config=readConfig(home)
  validateConfig(config)
  const api=remote || new GithubContents(config.repo, config.token)
  const key=remoteKey(config.channel)
  return {
    async sync() {
      await api.verifyPrivate?.()
      const state=loadState(home,config)
      if (config.role==='publisher') {
        const snapshot=buildSnapshot(home,config)
        const digest=contentDigest(snapshot)
        if (digest===state.lastPublishedDigest) return {state:'unchanged',role:'publisher'}
        const before=await api.get(key)
        if(before) {
          try {
            const existing=decrypt(JSON.parse(before.content),config.passphrase)
            validateSnapshot(existing,config)
            if(contentDigest(existing)===digest) {
              state.lastPublishedDigest=digest;saveState(home,state,config)
              return {state:'unchanged',role:'publisher'}
            }
          } catch {throw new Error('Remote snapshot cannot be decrypted; refusing overwrite')}
        }
        const encrypted=encrypt(snapshot,config.passphrase)
        await api.put(key,JSON.stringify(encrypted),before?.sha)
        state.lastPublishedDigest=digest;state.lastPublishedAt=now();saveState(home,state,config)
        return {state:'published',role:'publisher',files:Object.keys(snapshot.files).length,plugins:Object.keys(snapshot.plugins).length}
      }
      const before=await api.get(key)
      if(!before) return {state:'waiting-for-publisher',role:'subscriber'}
      if (before.sha===state.lastDownloadedSha && fs.existsSync(path.join(bridgeDir(home),'inbox.json'))) {
        const pending=loadInbox(home,config)
        validateSnapshot(pending,config)
        if(config.autoApply && state.hasApprovedFirstImport && state.lastAppliedDigest!==contentDigest(pending)) {
          return {state:'downloaded-and-applied',role:'subscriber',...applyInbox(home,config,{force:false})}
        }
        return {state:'unchanged',role:'subscriber'}
      }
      const snapshot=decrypt(JSON.parse(before.content),config.passphrase)
      validateSnapshot(snapshot,config)
      saveInbox(home,snapshot,config)
      state.lastDownloadedSha=before.sha;state.lastDownloadedAt=now();saveState(home,state,config)
      if(config.autoApply && state.hasApprovedFirstImport) {
        const applied=applyInbox(home,config,{force:false})
        return {state:'downloaded-and-applied',role:'subscriber',...applied}
      }
      return {state:'downloaded-needs-approval',role:'subscriber',files:Object.keys(snapshot.files).length,plugins:Object.keys(snapshot.plugins).length}
    },
    apply({force=false}={}) {
      if(config.role!=='subscriber')throw new Error('Only subscriber can apply an incoming snapshot')
      const result=applyInbox(home,config,{force})
      const state=loadState(home,config)
      // Only authorize background application once the initial import was conflict-free.
      if(result.conflicts.length===0){state.hasApprovedFirstImport=true;saveState(home,state,config)}
      return result
    },
    status() {
      const state=loadState(home,config)
      assertSafePath(home,'sync-bridge/inbox.json')
      const inbox=path.join(bridgeDir(home),'inbox.json')
      const pending=fs.existsSync(inbox) ? JSON.parse(fs.readFileSync(inbox,'utf8')) : null
      return {role:config.role,enabled:config.enabled,repo:config.repo,channel:config.channel,
        lastPublishedAt:state.lastPublishedAt||null,lastDownloadedAt:state.lastDownloadedAt||null,
        lastAppliedAt:state.lastAppliedAt||null,conflicts:state.conflicts||[],
        inboxPending:!!pending&&(!pending.bridgeScope||pending.bridgeScope===stateScope(config))&&state.lastAppliedDigest!==contentDigest(pending),
        approved:!!state.hasApprovedFirstImport}
    }
  }
}
