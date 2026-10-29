'use strict'

const fs = require('node:fs')
const Module = require('node:module')
const vm = require('node:vm')

/**
 * Evaluates a CommonJS file the way a bundler's output runs it. ESM output defines neither `__dirname` nor
 * `__filename`; CJS output defines them for the bundle file instead of the original one.
 *
 * @param {string} filename Absolute path of the file to evaluate; its dependencies resolve from there.
 * @param {{ dirname?: string, filename?: string }} [moduleScope] Values for `__dirname` and `__filename`.
 *   Omitted keys are left undefined, as in ESM output.
 * @returns {Record<string, unknown>} The file's `module.exports`.
 */
function loadAsBundled (filename, moduleScope = {}) {
  const params = ['exports', 'require', 'module']
  const args = []
  if ('dirname' in moduleScope) {
    params.push('__dirname')
    args.push(moduleScope.dirname)
  }
  if ('filename' in moduleScope) {
    params.push('__filename')
    args.push(moduleScope.filename)
  }

  const source = fs.readFileSync(filename, 'utf8')
  // Naming the script after the real file attributes its coverage to that file.
  const wrapped = vm.runInThisContext(`(function (${params.join(', ')}) {${source}\n})`, { filename })
  const module = { exports: {} }
  wrapped(module.exports, Module.createRequire(filename), module, ...args)
  return module.exports
}

module.exports = { loadAsBundled }
