'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const { OpenFeature } = require('@openfeature/server-sdk')
const { describe, it, beforeEach } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

// @ts-expect-error The minified vendored bundle does not expose the upstream module's type declarations.
const { DatadogNodeServerProvider } = require('../../../../vendor/dist/@datadog/openfeature-node-server')

require('../setup/core')

describe('DebugLoggingHook', () => {
  let DebugLoggingHook
  let log

  beforeEach(() => {
    log = {
      debug: sinon.spy(),
      warn: sinon.spy(),
    }

    DebugLoggingHook = proxyquire('../../src/openfeature/debug-logging-hook', {
      '../log': log,
      '../log/channels': { debugChannel: { hasSubscribers: true } },
    })
  })

  /**
   * @param {object} [overrides]
   */
  function hookContext (overrides) {
    return {
      flagKey: 'my-flag',
      flagValueType: 'boolean',
      defaultValue: false,
      context: { targetingKey: 'user-1', plan: 'pro' },
      hookData: new Map(),
      ...overrides,
    }
  }

  function loggedMessage () {
    sinon.assert.calledOnce(log.debug)
    const [messageFn] = log.debug.firstCall.args
    assert.strictEqual(typeof messageFn, 'function')
    return messageFn()
  }

  it('logs the evaluation inputs, configuration identity, and finally hook saw details on finally', () => {
    const configuration = { createdAt: '2026-01-01T00:00:00.000Z', environment: { name: 'Production' } }
    const hook = new DebugLoggingHook(() => configuration)
    const context = hookContext()
    const evaluationDetails = {
      flagKey: 'my-flag',
      value: true,
      variant: 'on',
      reason: 'TARGETING_MATCH',
      flagMetadata: { allocationKey: 'allocation-1', doLog: true },
    }

    hook.after(context, evaluationDetails)
    hook.finally(context, evaluationDetails)

    assert.strictEqual(
      loggedMessage(),
      'Feature Flags: evaluated my-flag (type=boolean, default=false, ' +
      "context={ targetingKey: 'user-1', plan: 'pro' }, " +
      'configuration observed at logging time: createdAt=2026-01-01T00:00:00.000Z, ' +
      'configuration environment=Production): ' +
      "finally hook saw { flagKey: 'my-flag', value: true, variant: 'on', reason: 'TARGETING_MATCH', " +
      "flagMetadata: { allocationKey: 'allocation-1', doLog: true } }"
    )
    sinon.assert.notCalled(log.warn)
  })

  it('logs error details and the missing configuration when evaluating before the provider is ready', () => {
    const hook = new DebugLoggingHook(() => undefined)
    const evaluationDetails = {
      flagKey: 'my-flag',
      value: false,
      reason: 'ERROR',
      errorCode: 'PROVIDER_NOT_READY',
      errorMessage: 'provider has not yet initialized',
      flagMetadata: {},
    }

    hook.finally(hookContext(), evaluationDetails)

    const message = loggedMessage()
    assert.match(message, /, no configuration observed at logging time\): finally hook saw /)
    assert.match(message, /errorCode: 'PROVIDER_NOT_READY', errorMessage: 'provider has not yet initialized'/)
    assert.doesNotMatch(message, /earlier resolution seen by provider hook:/)
  })

  it('distinguishes the provider resolution from a result replaced by a failing later hook', () => {
    const hook = new DebugLoggingHook()
    const context = hookContext()

    hook.after(context, { flagKey: 'my-flag', value: true, variant: 'on', reason: 'STATIC', flagMetadata: {} })
    hook.finally(context, {
      flagKey: 'my-flag',
      value: false,
      reason: 'ERROR',
      errorCode: 'GENERAL',
      errorMessage: 'application hook failed',
      flagMetadata: {},
    })

    assert.match(
      loggedMessage(),
      new RegExp(
        "finally hook saw \\{ flagKey: 'my-flag', value: false, reason: 'ERROR', errorCode: 'GENERAL', " +
        "errorMessage: 'application hook failed', flagMetadata: \\{\\} \\}; " +
        'earlier resolution seen by provider hook: ' +
        "\\{ flagKey: 'my-flag', value: true, variant: 'on', reason: 'STATIC', " +
        'flagMetadata: \\{\\} \\}$'
      )
    )
  })

  it('does not truncate large or deeply nested values', () => {
    const hook = new DebugLoggingHook()
    /** @type {object} */
    let nested = { leaf: 'x'.repeat(20_000) }
    for (let i = 0; i < 10; i++) nested = { level: i, nested }
    const list = Array.from({ length: 150 }, (_, index) => index)

    hook.finally(hookContext({ defaultValue: { list } }), { flagKey: 'my-flag', value: nested, flagMetadata: {} })

    const message = loggedMessage()
    assert.ok(message.includes('x'.repeat(20_000)))
    assert.ok(message.includes('149'))
    assert.doesNotMatch(message, /\[Object\]|more items|more characters/)
    assert.doesNotMatch(message, /\n/)
  })

  it('tolerates a missing hookContext and older SDKs without hook data', () => {
    const hook = new DebugLoggingHook()

    hook.after(undefined, { value: true })
    hook.after({ flagKey: 'my-flag' }, { value: true })
    hook.finally(undefined, { value: false })

    assert.strictEqual(
      loggedMessage(),
      'Feature Flags: evaluated undefined (type=undefined, default=undefined, context=undefined, ' +
      'no configuration observed at logging time): ' +
      'finally hook saw { value: false }'
    )
  })

  it('ignores custom inspection instead of losing raw values', () => {
    const hook = new DebugLoggingHook()
    const evilDetails = {
      value: true,
      [inspect.custom] () {
        throw new Error('boom: custom inspect exploded')
      },
    }
    log.debug = sinon.stub().callsFake((messageFn) => {
      // Mirrors the real logger, which runs the lazy callback when a subscriber is active.
      assert.match(messageFn(), /value: true/)
    })

    hook.finally({ flagKey: 'evil-flag' }, evilDetails)

    sinon.assert.notCalled(log.warn)
  })

  it('contains a failing configuration formatter', () => {
    log.debug = fn => fn()
    new DebugLoggingHook(() => { throw new Error('format failed') }).finally(hookContext(), { value: true })
    sinon.assert.calledWithExactly(log.warn, 'DebugLoggingHook: error in finally hook: %s', 'format failed')
  })

  it('renders real client contexts, types, fallbacks, hook failures and observed configuration', async () => {
    const messages = []
    log.debug = fn => messages.push(fn())
    const provider = new DatadogNodeServerProvider({ exposureChannel: { hasSubscribers: false } })
    const configuration = { createdAt: 'old', format: 'SERVER', environment: { name: 'test' }, flags: {} }
    const nested = { a: { b: { c: { leaf: 'x'.repeat(20_000), list: Array.from({ length: 150 }, (_, i) => i) } } } }
    /** @type {Array<[string, unknown, unknown]>} */
    const cases = [['Boolean', true, false], ['String', 'raw', 'default'], ['Number', 42, 0], ['Object', nested, {}]]
    for (const [type, value] of cases) {
      configuration.flags[type] = {
        key: type,
        enabled: true,
        variationType: { Object: 'JSON', Number: 'NUMERIC' }[type] ?? type.toUpperCase(),
        variations: { targeted: { key: 'targeted', value } },
        allocations: [{
          key: 'allocation',
          doLog: false,
          rules: [{ conditions: [{ attribute: 'plan', operator: 'ONE_OF', value: ['pro'] }] }],
          splits: [{ variationKey: 'targeted', shards: [] }],
        }],
      }
    }
    provider.hooks.push(new DebugLoggingHook(() => provider.getConfiguration()))
    provider.setConfiguration(configuration)
    try {
      await OpenFeature.setProviderAndWait('logging', provider)
      OpenFeature.setContext({ api: 'api' })
      const client = OpenFeature.getClient('logging')
      client.setContext({ client: 'client' })
      for (const [type, value, defaultValue] of cases) {
        const result = await client[`get${type}Details`](type, defaultValue, { targetingKey: 'user', plan: 'pro' })
        assert.deepStrictEqual(result.value, value)
        assert.strictEqual(result.variant, 'targeted')
        assert.match(messages.at(-1), /api: 'api', client: 'client', targetingKey: 'user', plan: 'pro'/)
        assert.match(messages.at(-1), /finally hook saw .*variant: 'targeted'/)
      }
      assert.ok(messages.at(-1).includes('x'.repeat(20_000)))
      assert.ok(messages.at(-1).includes('149'))
      assert.doesNotMatch(messages.at(-1), /more items|more characters|\[Object\]/)
      for (const [key, code] of [['missing', 'FLAG_NOT_FOUND'], ['String', 'TYPE_MISMATCH']]) {
        const result = await client.getBooleanDetails(key, false, { plan: 'pro' })
        assert.strictEqual(result.errorCode, code)
        assert.match(messages.at(-1), new RegExp(`errorCode: '${code}'`))
      }
      for (const flags of [{ ...configuration.flags, bad: {} }, { bad: {} }]) {
        provider.setConfiguration({ ...configuration, flags })
        assert.strictEqual((await client.getBooleanDetails('bad', false)).errorCode, 'PARSE_ERROR')
        assert.match(messages.at(-1), /errorCode: 'PARSE_ERROR'/)
      }
      provider.setConfiguration(configuration)
      client.addHooks({ after: () => provider.setConfiguration({ ...configuration, createdAt: 'new' }) })
      await client.getBooleanDetails('Boolean', false, { plan: 'pro' })
      assert.match(messages.at(-1), /configuration observed at logging time: createdAt=new/)
      client.addHooks({
        after: (_context, details) => {
          details.value = false
          throw new Error('application failed')
        },
      })
      const fallback = await client.getBooleanDetails('Boolean', false, { plan: 'pro' })
      assert.strictEqual(fallback.value, false)
      assert.match(messages.at(-1), /errorMessage: 'application failed'/)
      assert.match(messages.at(-1), /earlier resolution seen by provider hook: \{ value: true/)
    } finally {
      await OpenFeature.close()
      OpenFeature.setContext({})
    }
  })
})
