const { readFileSync, existsSync } = require('node:fs')
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

module.exports = {
  nativeRuntimePackages,
  nativeRuntimeUnpack: (root) =>
    [...nativeRuntimePackages(root).keys()].map((path) => `${path}/**`),
}
