#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import {stdin as input, stdout as output} from 'node:process'
import { createBridge, getHome, writeConfig, validateConfig, bridgeDir } from './core.js'

const home = getHome()
const command=process.argv[2]
const out=(value)=>console.log(JSON.stringify(value,null,2))
async function init() {
  const rl=readline.createInterface({input,output})
  try {
    const role=(await rl.question('Role (publisher on Mac / subscriber on Windows): ')).trim()
    const repo=(await rl.question('Private GitHub repository (owner/repo): ')).trim()
    const channel=(await rl.question('Shared channel name (e.g. personal-desktop): ')).trim()
    console.log('WARNING: token and passphrase are entered visibly and saved unencrypted in local.json. Use a private terminal; restrict file/backup access.')
    const token=(await rl.question('GitHub fine-grained token (Contents read/write): ')).trim()
    const passphrase=(await rl.question('Encryption passphrase (same on both computers, >=16 chars): ')).trim()
    const includeHomePatch=(await rl.question('Also sync ~/.dsh/cordis.patch.yml? May contain secrets! Type YES: ')).trim()==='YES'
    const autoApply=(await rl.question('Automatically apply future changes after first approved import? Type YES: ')).trim()==='YES'
    const current={enabled:true,role,repo,channel,token,passphrase,includeHomePatch,autoApply,intervalSeconds:90}
    validateConfig(current)
    // Validate without network before saving.
    writeConfig(home,current)
    console.log(`Saved local-only configuration to ${bridgeDir(home)}. Keep it private.`)
  } finally {rl.close()}
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
