'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')

const { afterEach, describe, it } = require('mocha')

require('../setup/core')

// Pins the optional-peer gate against leaking the provider chain into customer bundles (#8635).
// `file-tracing.spec.js` covers the same wrapper's nft contract.
describe('require-provider', () => {
  const modulePath = require.resolve('../../src/openfeature/require-provider')
  const peer = '@datadog/openfeature-node-server'

  afterEach(() => {
    delete require.cache[modulePath]
    delete globalThis.__webpack_require__
    delete globalThis.__non_webpack_require__
  })

  it('uses `require` outside a bundler', () => {
    assert.strictEqual(typeof globalThis.__webpack_require__, 'undefined')
    delete require.cache[modulePath]

    const { DatadogNodeServerProvider } = require(modulePath)

    assert.strictEqual(typeof DatadogNodeServerProvider, 'function')
  })

  it('uses `__non_webpack_require__`, never `__webpack_require__`, under webpack', () => {
    const loadCalls = []
    globalThis.__webpack_require__ = () => {
      throw new Error('webpack require must not run for an optional peer')
    }
    /** @param {string} request */
    globalThis.__non_webpack_require__ = (request) => {
      loadCalls.push(request)
      return require(request)
    }

    delete require.cache[modulePath]
    const { DatadogNodeServerProvider } = require(modulePath)

    assert.deepStrictEqual(loadCalls, [peer])
    assert.strictEqual(typeof DatadogNodeServerProvider, 'function')
  })

  it('falls back to `require` when `__non_webpack_require__` is absent', () => {
    globalThis.__webpack_require__ = () => {
      throw new Error('webpack require must not run for an optional peer')
    }

    delete require.cache[modulePath]
    const { DatadogNodeServerProvider } = require(modulePath)

    assert.strictEqual(typeof DatadogNodeServerProvider, 'function')
  })

  it('keeps the provider load opaque to bundlers', () => {
    const source = fs.readFileSync(modulePath, 'utf8')

    assert.doesNotMatch(
      source,
      /require\(\s*['"]@datadog\/openfeature-node-server['"]\s*\)/,
      'a literal require would let bundlers resolve the optional peer chain at build time'
    )
    assert.doesNotMatch(
      source,
      /\brequire\(\s*[^'"\s]/,
      'a dynamic require would create a webpack expression dependency'
    )
  })
})
