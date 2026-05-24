'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

require('../setup/core')
const { buildHolder, messageProxy } = require('../../src/plugins/log_injection')

describe('log_injection', () => {
  describe('buildHolder', () => {
    it('returns undefined when the propagator wrote nothing', () => {
      const tracer = { inject () {} }
      assert.strictEqual(buildHolder(tracer), undefined)
    })

    it('returns the holder when the propagator wrote at least one field', () => {
      const tracer = {
        inject (_span, _format, carrier) {
          carrier.dd = { service: 'svc' }
        },
      }
      const holder = buildHolder(tracer)
      assert.deepStrictEqual(holder.dd, { service: 'svc' })
    })
  })

  describe('messageProxy', () => {
    const holder = { dd: { service: 'svc', env: 'dev' } }

    it('exposes holder.dd through proxy get', () => {
      const message = { foo: 1 }
      const proxied = messageProxy(message, holder)
      assert.strictEqual(proxied.foo, 1)
      assert.deepStrictEqual(proxied.dd, { service: 'svc', env: 'dev' })
    })

    it('leaves the caller-owned object unchanged', () => {
      const message = { foo: 1 }
      messageProxy(message, holder)
      assert.strictEqual(Object.hasOwn(message, 'dd'), false)
    })

    it('does not override dd when the caller already set one', () => {
      const message = { dd: { mine: true } }
      const proxied = messageProxy(message, holder)
      assert.deepStrictEqual(proxied.dd, { mine: true })
    })

    it('lists dd in ownKeys when the target is extensible without an own dd', () => {
      const extensible = { foo: 1 }
      const proxied = messageProxy(extensible, holder)
      assert.deepStrictEqual(Reflect.ownKeys(proxied).sort(), ['dd', 'foo'])
    })

    it('omits dd from ownKeys when the target is non-extensible', () => {
      const frozen = Object.freeze({ foo: 1 })
      const proxied = messageProxy(frozen, holder)
      assert.deepStrictEqual(Reflect.ownKeys(proxied), ['foo'])
    })

    it('forwards writes to the target', () => {
      const message = { foo: 1 }
      const proxied = messageProxy(message, holder)
      proxied.bar = 2
      assert.strictEqual(message.bar, 2)
    })
  })
})
