#!/usr/bin/env node
/**
 * A sandboxed preload script can only require a few built-in modules. Any other `require("x")` left
 * in a built preload throws "module not found" when the page loads, and the tab it belongs to stays
 * white (no `window.desktopApi`, so nothing mounts). This reads every built preload and fails the
 * build when one still asks for something it cannot have, usually a workspace package that was
 * externalized instead of bundled (add it to that app's preload `externalizeDepsPlugin` exclude list).
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ALLOWED = new Set([
  'electron',
  'events',
  'timers',
  'url',
  'node:events',
  'node:timers',
  'node:url',
])
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const appsDir = join(root, 'apps')

const files = []
for (const app of readdirSync(appsDir)) {
  const dir = join(appsDir, app, 'out', 'preload')
  if (!existsSync(dir)) continue
  for (const name of readdirSync(dir))
    if (name.endsWith('.js') || name.endsWith('.cjs')) files.push(join(dir, name))
}

let failed = 0
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const bad = new Set()
  for (const match of text.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
    if (!ALLOWED.has(match[1])) bad.add(match[1])
  }
  if (bad.size > 0) {
    failed++
    console.error(`${relative(root, file)}: requires ${[...bad].join(', ')}`)
  }
}

if (files.length === 0) {
  console.log('check-preload-requires: no built preloads found (build the apps first)')
} else if (failed > 0) {
  console.error(`\n${failed} preload script(s) require modules a sandboxed preload cannot load.`)
  process.exit(1)
} else {
  console.log(`check-preload-requires: ${files.length} preload scripts are self-contained.`)
}
