'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const vm = require('node:vm')
const { describe, it } = require('mocha')

describe('bundler register', () => {
  it('replays builtins after a bundled registration without leaking the original require', () => {
    const filename = require.resolve('../../src/helpers/bundler-register')
    const source = fs.readFileSync(filename, 'utf8')
    const originalRequire = Module.prototype.require
    const dynamicRequires = []
    const staticRequires = []

    /** @param {string} request */
    function hookedRequire (request) {
      dynamicRequires.push(request)
      if (request === 'https') throw new Error('builtin unavailable')
      return {}
    }

    /** @param {string} request */
    function bundledRequire (request) {
      if (request === 'node:module') return Module
      if (request === './register') {
        Module.prototype.require = hookedRequire
        return {}
      }
      staticRequires.push(request)
      return {}
    }

    const bundledModule = { exports: {}, filename }
    const wrapper = vm.runInNewContext(Module.wrap(source), {}, { filename })
    let installedRequire
    try {
      wrapper.call(
        bundledModule.exports,
        bundledModule.exports,
        bundledRequire,
        bundledModule,
        filename,
        path.dirname(filename)
      )
      installedRequire = Module.prototype.require
    } finally {
      Module.prototype.require = originalRequire
    }

    assert.strictEqual(installedRequire, hookedRequire)
    assert.deepStrictEqual(dynamicRequires, ['http', 'https'])
    assert.deepStrictEqual(staticRequires, ['http', 'node:http', 'https', 'node:https'])
  })
})
