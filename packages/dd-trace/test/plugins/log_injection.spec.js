'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

require('../setup/core')
const { buildLogHolder, messageProxy } = require('../../src/plugins/log_injection')

describe('log_injection', () => {
  describe('buildLogHolder', () => {
    it('returns undefined when the propagator wrote nothing', () => {
      const tracer = { inject () {} }
      assert.strictEqual(buildLogHolder(tracer), undefined)
    })

    it('returns the log holder when the propagator wrote at least one field', () => {
      const tracer = {
        inject (_span, _format, carrier) {
          carrier.dd = { service: 'svc' }
        },
      }
      const logHolder = buildLogHolder(tracer)
      assert.deepStrictEqual(logHolder.dd, { service: 'svc' })
    })
  })

  describe('messageProxy', () => {
    const logHolder = { dd: { service: 'svc', env: 'dev' } }

    it('exposes logHolder.dd through proxy get', () => {
      const message = { foo: 1 }
      const proxied = messageProxy(message, logHolder)
      assert.strictEqual(proxied.foo, 1)
      assert.deepStrictEqual(proxied.dd, { service: 'svc', env: 'dev' })
    })

    it('leaves the caller-owned object unchanged', () => {
      const message = { foo: 1 }
      messageProxy(message, logHolder)
      assert.strictEqual(Object.hasOwn(message, 'dd'), false)
    })

    it('does not override dd when the caller already set one', () => {
      const message = { dd: { mine: true } }
      const proxied = messageProxy(message, logHolder)
      assert.deepStrictEqual(proxied.dd, { mine: true })
    })

    it('lists dd in ownKeys when the target is extensible without an own dd', () => {
      const extensible = { foo: 1 }
      const proxied = messageProxy(extensible, logHolder)
      assert.deepStrictEqual(Reflect.ownKeys(proxied).sort(), ['dd', 'foo'])
    })

    it('omits dd from ownKeys when the target is non-extensible', () => {
      const frozen = Object.freeze({ foo: 1 })
      const proxied = messageProxy(frozen, logHolder)
      assert.deepStrictEqual(Reflect.ownKeys(proxied), ['foo'])
    })

    it('forwards writes to the target', () => {
      const message = { foo: 1 }
      const proxied = messageProxy(message, logHolder)
      proxied.bar = 2
      assert.strictEqual(message.bar, 2)
    })
  })
})
