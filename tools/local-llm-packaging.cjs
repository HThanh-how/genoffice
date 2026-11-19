const { createRequire } = require('node:module')
const { readFileSync, existsSync } = require('node:fs')
const { join, dirname, relative } = require('node:path')

/** An unpacked ESM host must also see its JS dependency closure outside app.asar. */
function nativeRuntimePackages(root) {
  const found = new Map()
  function visit(name, from) {
    const requireFrom = createRequire(from)
    let dir
    try {
      dir = dirname(requireFrom.resolve(`${name}/package.json`))
    } catch {
      try {
        dir = dirname(requireFrom.resolve(name))
      } catch {
        return
      }
      while (!existsSync(join(dir, 'package.json'))) {
        const parent = dirname(dir)
        if (parent === dir) throw new Error(`Cannot locate native runtime dependency ${name}`)
        dir = parent
      }
    }
    const key = relative(root, dir).replace(/\\/g, '/')
    if (found.has(key)) return
    if (!key.startsWith('node_modules/'))
      throw new Error(`Native dependency escaped node_modules: ${key}`)
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    found.set(key, dir)
    for (const dependency of Object.keys(pkg.dependencies ?? {}))
      visit(dependency, join(dir, 'package.json'))
  }
  visit('node-llama-cpp', join(root, 'package.json'))
  return found
}

module.exports = {
  nativeRuntimePackages,
  nativeRuntimeUnpack: (root) =>
    [...nativeRuntimePackages(root).keys()].map((path) => `${path}/**`),
}
