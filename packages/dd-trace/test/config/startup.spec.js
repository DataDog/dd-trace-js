'use strict'

const assert = require('node:assert/strict')

const proxyquire = require('proxyquire').noCallThru().noPreserveCache()
const sinon = require('sinon')

const artifact = JSON.stringify({ major: 7, bindings: [] })
const layers = [{ origin: 'env_var', entries: [{ name: 'DD_ENV', value: 'production' }] }]

/**
 * @param {() => string} readFileSync
 * @param {() => object | undefined} maybeLoad
 */
function startup (readFileSync, maybeLoad = () => undefined) {
  return proxyquire('../../src/config/startup', {
    'node:fs': { readFileSync },
    '@datadog/libdatadog-extras': { maybeLoad },
  })
}

describe('resolve startup configuration', () => {
  it('uses the tracer fallback when the prepared asset is absent', () => {
    const { resolveStartup } = startup(() => {
      throw Object.assign(new Error('file missing'), { code: 'ENOENT' })
    })
    const debug = sinon.spy()
    assert.strictEqual(resolveStartup(layers, 7, undefined, { debug }), undefined)
    sinon.assert.notCalled(debug)
  })

  it('reports an unreadable prepared asset', () => {
    const { resolveStartup } = startup(() => '{')
    const debug = sinon.spy()
    assert.strictEqual(resolveStartup(layers, 7, undefined, { debug }), undefined)
    sinon.assert.calledOnceWithMatch(debug, 'Cannot load the prepared configuration manifest: %s')
  })

  it('uses the tracer fallback when the platform has no native addon', () => {
    const { resolveStartup } = startup(() => artifact)
    assert.strictEqual(resolveStartup(layers, 7, undefined, { debug: sinon.spy() }), undefined)
  })

  it('reports an addon load error and uses the tracer fallback', () => {
    const { resolveStartup } = startup(() => artifact, () => {
      throw new Error('cannot load addon')
    })
    const debug = sinon.spy()
    assert.strictEqual(resolveStartup(layers, 7, undefined, { debug }), undefined)
    sinon.assert.calledOnceWithExactly(debug, 'Cannot use the native configuration resolver: %s', 'cannot load addon')
  })

  it('leaves programmatic options to the tracer when a host transform is required', () => {
    const { resolveStartup } = startup(() => artifact, () => ({
      JsConfigResolver: class {
        request () {
          return Buffer.from(JSON.stringify({
            status: 'pending',
            requests: [{ slot: 0, key: 'DD_ENV', origin: 'code', value: { kind: 'string', value: 'production' } }],
          }))
        }
      },
    }))
    const options = [{ origin: 'code', entries: [{ name: 'env', value: { kind: 'string', value: 'production' } }] }]
    assert.strictEqual(resolveStartup(options, 7, undefined, { debug: sinon.spy() }, {}), undefined)
  })

  it('decodes a JSON transform input and reports a native continuation error', () => {
    const transform = sinon.stub().returns({ parsed: true })
    const debug = sinon.spy()
    const { resolveStartup } = startup(() => artifact, () => ({
      JsConfigResolver: class {
        /**
         * @param {Buffer} input
         */
        request (input) {
          const { operation } = JSON.parse(input.toString())
          if (operation === 'resume') {
            return Buffer.from(JSON.stringify({ status: 'error', message: 'incompatible host transform result' }))
          }
          const value = { kind: 'json', value: '{"key":"value"}' }
          return Buffer.from(JSON.stringify({
            status: 'pending',
            requests: [{ slot: 0, key: 'DD_ENV', origin: 'env_var', value }],
          }))
        }
      },
    }))
    assert.strictEqual(resolveStartup(layers, 7, transform, { debug }), undefined)
    sinon.assert.calledOnceWithExactly(transform, 'DD_ENV', { key: 'value' }, 'env_var')
    sinon.assert.calledOnceWithMatch(debug, 'Cannot finish native configuration resolution: %s')
  })
})
