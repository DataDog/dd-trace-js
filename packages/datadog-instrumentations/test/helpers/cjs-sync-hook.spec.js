'use strict'

const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, realpathSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, join } = require('node:path')
const { describe, it, beforeEach } = require('mocha')

const { registerCjsHook, applyCjsHooks, moduleHooks } = require('../../src/helpers/cjs-sync-hook')
const { filename } = require('../../src/helpers/register')

// The sync-hook CJS path must hand the per-module callback the same moduleName
// require-in-the-middle would. register.js matches a hook by comparing that name
// against `filename(name, file)`, which is the *bare* package name when the hook
// declares no `file:` (package-main hooks like `router`, `mongoose`, `undici`).
// Building `<pkg>/index.js` for the main entry made every package-main hook miss.
describe('cjs-sync-hook moduleName', () => {
  /**
   * Writes a throwaway installed package on disk so the test owns a real
   * basedir, package.json `main`, and module-internal files without depending on
   * a versioned fixture being installed. Pass `createMain: false` to leave the
   * `main` entry missing (the "main can't be resolved" case).
   *
   * @param {string} name Package name.
   * @param {{ main?: string, createMain?: boolean, files?: string[] }} [layout]
   * @returns {{ basedir: string, main: string, file: (relative: string) => string }}
   */
  function installPackage (name, { main = 'index.js', createMain = true, files = [] } = {}) {
    // realpathSync so paths match what createRequire().resolve() reports inside
    // the hook — on macOS the OS temp dir is a /var -> /private/var symlink.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dd-cjs-sync-hook-')))
    const basedir = join(root, 'node_modules', name)
    mkdirSync(basedir, { recursive: true })
    writeFileSync(join(basedir, 'package.json'), `{"version":"1.0.0","main":"${main}"}`)
    const file = relative => {
      const absolute = join(basedir, relative)
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, 'module.exports = {}\n')
      return absolute
    }
    if (createMain) file(main)
    for (const relative of files) file(relative)
    moduleHooks.delete(name)
    return { basedir, main: join(basedir, main), file }
  }

  beforeEach(() => {
    moduleHooks.delete('mainpkg')
    moduleHooks.delete('brokenmain')
  })

  it('passes the bare package name for the package main', () => {
    const pkg = installPackage('mainpkg')
    let received
    registerCjsHook('mainpkg', (exports, name) => {
      received = name
      return exports
    })

    applyCjsHooks({}, pkg.main)

    assert.strictEqual(received, 'mainpkg')
    assert.strictEqual(received, filename('mainpkg', undefined))
  })

  it('passes <pkg>/<relative-path> for a module-internal file', () => {
    const pkg = installPackage('mainpkg', { files: ['lib/internal.js'] })
    let received
    registerCjsHook('mainpkg', (exports, name) => {
      received = name
      return exports
    })

    applyCjsHooks({}, pkg.file('lib/internal.js'))

    assert.strictEqual(received, 'mainpkg/lib/internal.js')
    assert.strictEqual(received, filename('mainpkg', 'lib/internal.js'))
  })

  it('falls back to <pkg>/<relative-path> when the main entry cannot be resolved', () => {
    // A package whose "main" points at a non-existent file makes the main
    // resolution throw; the hook must still fire with the relative name rather
    // than crash the require.
    const pkg = installPackage('brokenmain', { main: 'does-not-exist.js', createMain: false })
    let received
    registerCjsHook('brokenmain', (exports, name) => {
      received = name
      return exports
    })

    applyCjsHooks({}, pkg.file('present.js'))

    assert.strictEqual(received, 'brokenmain/present.js')
  })
})
