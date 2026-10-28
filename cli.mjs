#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import {stdin as input, stdout as output} from 'node:process'
import { createBridge, getHome, writeConfig, validateConfig, bridgeDir } from './core.js'

const home = getHome()
const command=process.argv[2]
const out=(value)=>console.log(JSON.stringify(value,null,2))

// One long-lived line reader for every plain question. node:readline/promises'
// question() resolves empty on piped stdin, and closing a reader discards data
// already buffered behind it, so the wizard never tears the reader down midway:
// it drains queued lines first and only then waits for the next one.
function asker() {
  const rl=readline.createInterface({input,output})
  const queue=[]
  const asks=[]
  let closed=false
  // Lines and questions are matched in order: whichever arrives first is queued,
  // so a reader that already drained a whole pipe still answers every question.
  rl.on('line',(line)=>{ const resolve=asks.shift(); if(resolve) resolve(line); else queue.push(line) })
  rl.on('close',()=>{ closed=true; while(asks.length) asks.shift()('') })
  const ask=async(question)=>{
    output.write(question)
    if(queue.length) return queue.shift()
    if(closed) return ''
    return await new Promise((resolve)=>{asks.push(resolve)})
  }
  return {ask, close:()=>{ if(!closed) rl.close() }}
}

// Masked input for secrets. Raw keystrokes are only intercepted on a TTY; a
// pipe or a redirected file carries no echo to hide, so it stays a plain read.
async function secret(question, plain) {
  if (!input.isTTY) return (await plain.ask(question)).trim()
  return new Promise((resolve) => {
    let value=''
    output.write(question)
    const wasRaw=process.stdin.isRaw
    input.setRawMode(true)
    input.resume()
    input.setEncoding('utf8')
    const cleanup=()=>{
      input.setRawMode(Boolean(wasRaw))
      input.pause()
      input.removeListener('data',onData)
    }
    const onData=(chunk)=>{
      for (const ch of chunk) {
        if (ch==='\r' || ch==='\n') { cleanup(); output.write('\n'); resolve(value.trim()); return }
        if (ch==='\u0003') { cleanup(); output.write('\n'); process.exit(130) }
        if (ch==='\u007f' || ch==='\b') { if (value) { value=value.slice(0,-1); output.write('\b \b') } continue }
        if (ch==='\u0015') { value=''; output.write('\r\u001b[K'+question); continue }
        value+=ch
        output.write('*')
      }
    }
    input.on('data',onData)
  })
}

async function init() {
  const plain=asker()
  try {
    const role=(await plain.ask('Role (publisher on Mac / subscriber on Windows): ')).trim()
    const repo=(await plain.ask('Private GitHub repository (owner/repo): ')).trim()
    const channel=(await plain.ask('Shared channel name (e.g. personal-desktop): ')).trim()
    console.log('Token and passphrase are masked on entry (Ctrl-U clears, Ctrl-C aborts) but are still stored unencrypted in local.json. Keep that file out of backups and shared folders.')
    const token=await secret('GitHub fine-grained token (Contents read/write): ', plain)
    const passphrase=await secret('Encryption passphrase (same on both computers, >=16 chars): ', plain)
    const includeHomePatch=(await plain.ask('Also sync ~/.dsh/cordis.patch.yml? May contain secrets! Type YES: ')).trim()==='YES'
    const autoApply=(await plain.ask('Automatically apply future changes after first approved import? Type YES: ')).trim()==='YES'
    const current={enabled:true,role,repo,channel,token,passphrase,includeHomePatch,autoApply,intervalSeconds:90}
    validateConfig(current)
    // Validate without network before saving.
    writeConfig(home,current)
    console.log(`Saved local-only configuration to ${bridgeDir(home)}. Keep it private.`)
  } finally {plain.close()}
}
try {
  if(command==='init') await init()
  else if(command==='sync') out(await createBridge({home}).sync())
  else if(command==='apply') out(createBridge({home}).apply({force:process.argv.includes('--force')}))
  else if(command==='status') out(createBridge({home}).status())
  else if(command==='show-desired-plugins') {
    const p=path.join(bridgeDir(home),'desired-plugins.json')
    if(!fs.existsSync(p)) throw new Error('No plugin manifest; download and apply snapshot first')
    const desired=JSON.parse(fs.readFileSync(p,'utf8'))
    const current=JSON.parse(fs.readFileSync(path.join(home,'profiles','desktop','package.json'),'utf8'))
    const actual=current.dependencies||{}
    const toInstall=Object.entries(desired).filter(([key,val])=>actual[key]!==val)
    out({toInstall, note:'Quit DSH Desktop before installing via dsh plugin --profile desktop add <package>@<version>. Do not copy node_modules or lockfiles.'})
  } else {
    console.log('Usage: node cli.mjs init | sync | apply [--force] | status | show-desired-plugins')
    process.exitCode=command?2:0
  }
} catch(e){console.error('DSH Sync Bridge:',e.message);process.exitCode=1}
