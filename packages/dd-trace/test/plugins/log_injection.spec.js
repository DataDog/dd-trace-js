'use strict'

const assert = require('node:assert/strict')

const { afterEach, describe, it } = require('mocha')
const { storage } = require('../../../datadog-core')

require('../setup/core')
const {
  createStoreRetirement,
  enterSpanForRetirement,
  markSpanProcessed,
} = require('../../src/active-span')
const { buildLogHolder, messageProxy } = require('../../src/plugins/log_injection')

const legacyStorage = storage('legacy')

describe('log_injection', () => {
  afterEach(() => {
    legacyStorage.enterWith(undefined)
  })

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

    it('injects the retired span context', () => {
      const context = {}
      let injected
      const tracer = {
        inject (parent, _format, carrier) {
          injected = parent
          carrier.dd = { trace_id: '1' }
        },
      }
      const span = {
        _duration: 1,
        context: () => context,
        tracer: () => tracer,
      }
      const retirement = createStoreRetirement()
      enterSpanForRetirement(span, {}, retirement)
      retirement.retire()
      markSpanProcessed(span)

      buildLogHolder(tracer)

      assert.strictEqual(injected.context(), context)
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
