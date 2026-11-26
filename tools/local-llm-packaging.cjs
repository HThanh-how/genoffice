const { readFileSync, existsSync, cpSync } = require('node:fs')
const { join, dirname, relative, sep } = require('node:path')

/** An unpacked ESM host must also see its JS dependency closure outside app.asar. */
function nativeRuntimePackages(root) {
  const found = new Map()
  // Walk node_modules directories the way Node's resolver does. require.resolve cannot be used:
  // ESM-only packages (chalk, ora, nanoid ...) have an exports map that blocks both
  // `<name>/package.json` and a CommonJS main, and they must still be unpacked next to the host.
  function locate(name, fromDir) {
    for (let dir = fromDir; ; dir = dirname(dir)) {
      const candidate = join(dir, 'node_modules', name)
      if (existsSync(join(candidate, 'package.json'))) return candidate
      if (dirname(dir) === dir) return null
    }
  }
  function visit(name, fromDir) {
    const dir = locate(name, fromDir)
    if (!dir) return
    const key = relative(root, dir).split(sep).join('/')
    if (found.has(key)) return
    if (!key.startsWith('node_modules/'))
      throw new Error(`Native dependency escaped node_modules: ${key}`)
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    found.set(key, dir)
    for (const dependency of Object.keys(pkg.dependencies ?? {})) visit(dependency, dir)
  }
  visit('node-llama-cpp', root)
  return found
}

/**
 * Put the host's whole dependency closure next to it, exactly as the repository resolves it.
 * electron-builder's own dependency collector flattens the tree and drops or misplaces nested
 * versions (the packaged app shipped node-llama-cpp/node_modules with ipull's packages and without
 * chalk 5 and nanoid), so the unpacked ESM host died with ERR_MODULE_NOT_FOUND at the first chat.
 * Runs from afterPack, once app.asar.unpacked exists. node-llama-cpp itself and the platform
 * binaries are already shipped by the `files` rules.
 */
function copyNativeRuntime(root, resourcesDir) {
  let copied = 0
  for (const [key, dir] of nativeRuntimePackages(root)) {
    if (key === 'node_modules/node-llama-cpp' || key.startsWith('node_modules/@node-llama-cpp/'))
      continue
    cpSync(dir, join(resourcesDir, 'app.asar.unpacked', ...key.split('/')), {
      recursive: true,
      force: true,
    })
    copied += 1
  }
  return copied
}

module.exports = {
  copyNativeRuntime,
  nativeRuntimePackages,
  nativeRuntimeUnpack: (root) =>
    [...nativeRuntimePackages(root).keys()].map((path) => `${path}/**`),
}
