import { createBridge, getHome, readConfig } from './core.js'

export const name = 'dsh-sync-bridge-local'

export function apply(ctx) {
  // No network traffic until the owner explicitly runs cli.mjs init.
  const home = getHome()
  const config = readConfig(home)
  if (!config?.enabled) return
  const bridge = createBridge({ home })
  let working = false
  const sync = async () => {
    if (working) return
    working = true
    try { await bridge.sync() }
    catch (error) { console.error('[DSH Sync Bridge] sync failed:', error.message) }
    finally { working = false }
  }
  ctx.effect(() => {
    const interval = setInterval(sync, Math.max(30000, config.intervalSeconds * 1000 || 90000))
    // A short deferred first run avoids slowing DSH startup.
    const startup = setTimeout(sync, 8000)
    return () => { clearInterval(interval); clearTimeout(startup) }
  })
}
