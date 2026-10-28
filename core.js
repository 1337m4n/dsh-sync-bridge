import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const encoder = new TextEncoder()
const MAX_ASSET = 3 * 1024 * 1024
const MAX_TOTAL = 8 * 1024 * 1024
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
  const file = configFile(home)
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
export function writeConfig(home, config) {
  fs.mkdirSync(bridgeDir(home), {recursive:true,mode:0o700})
  fs.writeFileSync(configFile(home), JSON.stringify(config,null,2)+'\n',{mode:0o600})
  try { fs.chmodSync(configFile(home),0o600) } catch {}
}
function loadState(home) {
  const p = path.join(bridgeDir(home), 'state.json')
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,'utf8')) : {}
}
function saveState(home, value) {
  const p = path.join(bridgeDir(home),'state.json')
  atomicWrite(p,JSON.stringify(value,null,2)+'\n')
}
function atomicWrite(p, value) {
  fs.mkdirSync(path.dirname(p),{recursive:true})
  const tmp = `${p}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp,value,{mode:0o600})
  try {fs.renameSync(tmp,p)} catch(e){try{fs.rmSync(tmp,{force:true})}catch{};throw e}
}
function validateConfig(c) {
  if (!c || !['publisher','subscriber'].includes(c.role)) throw new Error('role must be publisher or subscriber')
  if (typeof c.repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(c.repo)) throw new Error('repo must be owner/name')
  if (typeof c.channel !== 'string' || !/^[a-zA-Z0-9_-]{3,50}$/.test(c.channel)) throw new Error('channel requires 3–50 ASCII letters/digits/-/_')
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
  if (blob?.v!==1 || blob.alg!=='aes-256-gcm+scrypt') throw new Error('Unknown encrypted snapshot version')
  const key = crypto.scryptSync(passphrase,unb64(blob.salt),32,{N:32768,r:8,p:1,maxmem:64*1024*1024})
  const decipher = crypto.createDecipheriv('aes-256-gcm',key,unb64(blob.iv))
  decipher.setAAD(encoder.encode('dsh-sync-bridge:v1'))
  decipher.setAuthTag(unb64(blob.tag))
  return JSON.parse(Buffer.concat([decipher.update(unb64(blob.ciphertext)),decipher.final()]).toString('utf8'))
}
function relativeSafe(rel) {
  if (typeof rel !== 'string' || rel.startsWith('/') || rel.includes('\\')) return false
  const parts = rel.split('/')
  return parts.length > 0 && parts.every(p => p && p!=='.' && p!=='..')
}
function isAllowed(rel, settings) {
  if (!relativeSafe(rel)) return false
  if (rel===allowedProfile) return true
  if (rel===allowedHome) return !!settings.includeHomePatch
  return rel.startsWith(assetRoot+'/') && SAFE_ASSETS.has(path.extname(rel).toLowerCase())
}
function scanAssets(home, dir, out, current) {
  if (!fs.existsSync(dir)) return
  for (const item of fs.readdirSync(dir,{withFileTypes:true})) {
    const full = path.join(dir,item.name)
    if (item.isSymbolicLink()) continue
    if (item.isDirectory()) { scanAssets(home,full,out,current); continue }
    if (!item.isFile()) continue
    const rel = path.relative(home,full).split(path.sep).join('/')
    if (!isAllowed(rel,current)) continue
    if (fs.statSync(full).size > MAX_ASSET) throw new Error(`Asset exceeds 3 MiB: ${rel}`)
    out[rel] = fs.readFileSync(full).toString('base64')
  }
}
export function buildSnapshot(home, settings) {
  const files = {}
  for (const rel of [allowedProfile, ...(settings.includeHomePatch?[allowedHome]:[])]) {
    const full = path.join(home,...rel.split('/'))
    if (fs.existsSync(full)) {
      if (fs.lstatSync(full).isSymbolicLink()) continue
      const size = fs.statSync(full).size
      if (size>MAX_ASSET) throw new Error(`Config exceeds 3 MiB: ${rel}`)
      files[rel] = fs.readFileSync(full).toString('base64')
    }
  }
  scanAssets(home,path.join(home,assetRoot),files,settings)
  let manifest = {}
  const profilePackage = path.join(home,'profiles','desktop','package.json')
  if (fs.existsSync(profilePackage)) {
    const data=JSON.parse(fs.readFileSync(profilePackage,'utf8'))
    // Only package names and version specifiers; never copy executable packages, locks, or profile metadata.
    manifest = Object.fromEntries(Object.entries(data.dependencies||{}).filter(([pkg,version]) =>
      !pkg.startsWith('@deepseek-ai/') && typeof version==='string' && !/^(file:|link:|workspace:|\.|\/)/.test(version)))
  }
  let bytes=0
  for (const value of Object.values(files)) bytes+=Buffer.byteLength(value,'base64')
  if (bytes>MAX_TOTAL) throw new Error('Snapshot exceeds 8 MiB; remove large assets')
  return {schema:1,generatedAt:now(),files,plugins:manifest}
}
function contentDigest(data) {
  return sha(JSON.stringify({files:data.files,plugins:data.plugins}))
}
class GithubContents {
  constructor(repo,token) { this.repo=repo;this.token=token }
  async request(method, key, payload) {
    const url=`https://api.github.com/repos/${this.repo}/contents/${key}`
    const res=await fetch(url,{
      method,
      headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${this.token}`,'X-GitHub-Api-Version':'2022-11-28', ...(payload?{'Content-Type':'application/json'}:{})},
      ...(payload?{body:JSON.stringify(payload)}:{})
    })
    if (res.status===404 && method==='GET') return null
    if (!res.ok) throw new Error(`GitHub ${method}: HTTP ${res.status} ${String(await res.text()).slice(0,250)}`)
    return res.json()
  }
  async get(key) {
    const r=await this.request('GET',key)
    if(!r) return null
    if(r.type!=='file') throw new Error('Unexpected remote entry')
    // Contents API omits inline content above 1 MiB. Fetch the same Git blob instead.
    const record = r.content ? r : await this.request('GET',`git/blobs/${r.sha}`)
    if(record?.encoding!=='base64' || !record.content) throw new Error('GitHub returned no base64 blob content')
    return {sha:r.sha,content:Buffer.from(record.content.replace(/\s/g,''),'base64').toString('utf8')}
  }
  async put(key,content,oldSha) {
    return this.request('PUT',key,{message:'Update encrypted DSH Bridge snapshot',content:b64(content),...(oldSha?{sha:oldSha}:{})})
  }
}
function remoteKey(channel) {return `dsh-sync-bridge/${channel}/snapshot.json`}
function hasSymlinkParent(home, rel) {
  let current = home
  for (const section of rel.split('/').slice(0,-1)) {
    current=path.join(current,section)
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) return true
  }
  return false
}
function currentSha(home,rel) {
  const p=path.join(home,...rel.split('/'))
  return fs.existsSync(p) && fs.statSync(p).isFile() ? sha(fs.readFileSync(p)) : null
}
function saveInbox(home, snapshot) {
  const inbox=path.join(bridgeDir(home),'inbox.json')
  atomicWrite(inbox, JSON.stringify(snapshot,null,2)+'\n')
}
function loadInbox(home) {
  const p=path.join(bridgeDir(home),'inbox.json')
  if(!fs.existsSync(p)) throw new Error('No incoming snapshot; run sync first')
  return JSON.parse(fs.readFileSync(p,'utf8'))
}
export function applyInbox(home, config, options={}) {
  const inbox=loadInbox(home)
  const state=loadState(home)
  const digest=contentDigest(inbox)
  const conflicts=[]
  const applied=[]
  const backupDir=path.join(bridgeDir(home),'backups',new Date().toISOString().replace(/[:.]/g,'-'))
  for (const [rel,base64] of Object.entries(inbox.files||{})) {
    if (!isAllowed(rel,config)) throw new Error(`Unapproved remote path: ${rel}`)
    const target=path.join(home,...rel.split('/'))
    if (hasSymlinkParent(home,rel) || (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink())) {conflicts.push({path:rel,reason:'symlink path'});continue}
    const next=Buffer.from(base64,'base64')
    if (next.length>MAX_ASSET) throw new Error('Oversized remote item')
    const nextHash=sha(next)
    const localHash=currentSha(home,rel)
    const previous=state.appliedHashes?.[rel]
    // On the first import, require explicit --force for existing, differing files.
    const diverged= localHash && localHash!==nextHash && (previous===undefined ? !options.force : localHash!==previous)
    if(diverged) {conflicts.push({path:rel,reason:'local content differs'});continue}
    if(localHash===nextHash){applied.push(rel);continue}
    if(fs.existsSync(target)) {
      const backup=path.join(backupDir,...rel.split('/'))
      fs.mkdirSync(path.dirname(backup),{recursive:true})
      fs.copyFileSync(target,backup)
    }
    atomicWrite(target,next)
    applied.push(rel)
  }
  // The package list is advisory only: never mutate desktop's package.json while running.
  atomicWrite(path.join(bridgeDir(home),'desired-plugins.json'), JSON.stringify(inbox.plugins||{},null,2)+'\n')
  state.appliedHashes = state.appliedHashes||{}
  for (const rel of applied) state.appliedHashes[rel]=currentSha(home,rel)
  state.lastAppliedAt=now()
  state.lastAppliedDigest=digest
  state.conflicts=conflicts
  saveState(home,state)
  return {applied,conflicts,desiredPluginCount:Object.keys(inbox.plugins||{}).length}
}
export function createBridge({home=getHome(), remote}={}) {
  const config=readConfig(home)
  validateConfig(config)
  const api=remote || new GithubContents(config.repo, config.token)
  const key=remoteKey(config.channel)
  return {
    async sync() {
      const state=loadState(home)
      if (config.role==='publisher') {
        const snapshot=buildSnapshot(home,config)
        const digest=contentDigest(snapshot)
        if (digest===state.lastPublishedDigest) return {state:'unchanged',role:'publisher'}
        const before=await api.get(key)
        if(before) {
          try {
            const existing=decrypt(JSON.parse(before.content),config.passphrase)
            if(contentDigest(existing)===digest) {
              state.lastPublishedDigest=digest;saveState(home,state)
              return {state:'unchanged',role:'publisher'}
            }
          } catch {throw new Error('Remote snapshot cannot be decrypted; refusing overwrite')}
        }
        const encrypted=encrypt(snapshot,config.passphrase)
        await api.put(key,JSON.stringify(encrypted),before?.sha)
        state.lastPublishedDigest=digest;state.lastPublishedAt=now();saveState(home,state)
        return {state:'published',role:'publisher',files:Object.keys(snapshot.files).length,plugins:Object.keys(snapshot.plugins).length}
      }
      const before=await api.get(key)
      if(!before) return {state:'waiting-for-publisher',role:'subscriber'}
      if (before.sha===state.lastDownloadedSha) return {state:'unchanged',role:'subscriber'}
      const snapshot=decrypt(JSON.parse(before.content),config.passphrase)
      if(snapshot?.schema!==1 || !snapshot.files || !snapshot.plugins) throw new Error('Invalid remote snapshot structure')
      for (const rel of Object.keys(snapshot.files)) if(!isAllowed(rel,config)) throw new Error(`Unexpected remote file: ${rel}`)
      saveInbox(home,snapshot)
      state.lastDownloadedSha=before.sha;state.lastDownloadedAt=now();saveState(home,state)
      if(config.autoApply && state.hasApprovedFirstImport) {
        const applied=applyInbox(home,config,{force:false})
        return {state:'downloaded-and-applied',role:'subscriber',...applied}
      }
      return {state:'downloaded-needs-approval',role:'subscriber',files:Object.keys(snapshot.files).length,plugins:Object.keys(snapshot.plugins).length}
    },
    apply({force=false}={}) {
      if(config.role!=='subscriber')throw new Error('Only subscriber can apply an incoming snapshot')
      const result=applyInbox(home,config,{force})
      const state=loadState(home)
      // Only authorize background application once the initial import was conflict-free.
      if(result.conflicts.length===0){state.hasApprovedFirstImport=true;saveState(home,state)}
      return result
    },
    status() {
      const state=loadState(home)
      const inbox=path.join(bridgeDir(home),'inbox.json')
      return {role:config.role,enabled:config.enabled,repo:config.repo,channel:config.channel,
        lastPublishedAt:state.lastPublishedAt||null,lastDownloadedAt:state.lastDownloadedAt||null,
        lastAppliedAt:state.lastAppliedAt||null,conflicts:state.conflicts||[],
        inboxPending:fs.existsSync(inbox)&&state.lastAppliedDigest!==contentDigest(JSON.parse(fs.readFileSync(inbox,'utf8'))),
        approved:!!state.hasApprovedFirstImport}
    }
  }
}
