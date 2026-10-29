'use strict'

const assert = require('node:assert/strict')

const { OpenFeature } = require('@openfeature/server-sdk')
const { DatadogNodeServerProvider } = require('@datadog/openfeature-node-server')
const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')

const configuration = {
  createdAt: '2026-10-23T00:00:00.000Z',
  format: 'ufc-v1',
  environment: { name: 'test' },
  flags: {
    'holdout-flag': {
      key: 'holdout-flag',
      enabled: true,
      variationType: 'BOOLEAN',
      variations: {
        control: { key: 'control', value: false },
        treatment: { key: 'treatment', value: true },
      },
      allocations: [
        {
          key: 'holdout-allocation',
          doLog: true,
          splits: [
            {
              variationKey: 'control',
              serialId: 1001,
              shards: [{ salt: 'test-salt', ranges: [{ start: 0, end: 10000 }], totalShards: 10000 }],
              features: [
                { key: 'holdout.key', value: '06ad', destinations: ['HOOK'] },
                { key: 'holdout.assignment_group', value: 'status_quo', destinations: ['HOOK'] },
                { key: 'holdout.should_include_in_holdout_analysis', value: false, destinations: ['HOOK'] },
                { key: 'exposure.only', value: 'exposed', destinations: ['EXPOSURE'] },
                { key: 'evaluation.only', value: 7, destinations: ['EVALUATION'] },
              ],
            },
          ],
        },
      ],
    },
  },
}

describe('ExposureHook', () => {
  let ExposureHook
  let log
  let exposureChannel
  let provider

  beforeEach(async () => {
    log = { debug: sinon.spy(), info: sinon.spy(), warn: sinon.spy(), error: sinon.spy() }
    ;({ ExposureHook } = proxyquire('../../src/openfeature/exposure-hook', {
      '../log': log,
    }))

    exposureChannel = { hasSubscribers: true, publish: sinon.spy() }
    provider = new DatadogNodeServerProvider({ exposureChannel })
    provider.setConfiguration(configuration)
  })

  afterEach(async () => {
    await OpenFeature.clearProviders()
    sinon.restore()
  })

  it('exposes the evaluation with the Datadog exposure decision', async () => {
    const evaluations = []
    const clientHook = new ExposureHook(evaluation => evaluations.push(evaluation))
    await OpenFeature.setProviderAndWait(provider)
    const client = OpenFeature.getClient()
    client.addHooks(clientHook)

    const result = await client.getBooleanDetails('holdout-flag', true, { targetingKey: 'subject-1' })
    await client.getBooleanDetails('holdout-flag', true, { targetingKey: 'subject-1' })

    assert.strictEqual(evaluations.length, 2)
    const [first, repeat] = evaluations
    assert.strictEqual(first.details.flagKey, 'holdout-flag')
    assert.strictEqual(first.details.value, result.value)
    assert.strictEqual(first.details.variant, 'control')
    assert.strictEqual(first.details.flagMetadata.allocationKey, 'holdout-allocation')
    assert.strictEqual(first.flagKey, 'holdout-flag')
    assert.strictEqual(first.variant, 'control')
    assert.strictEqual(first.allocation, 'holdout-allocation')
    assert.strictEqual(first.targetingKey, 'subject-1')
    assert.strictEqual(first.context.targetingKey, 'subject-1')
    assert.ok(first.isExposure())
    assert.ok(!first.isCacheHit())
    assert.ok(first.shouldSend())

    assert.ok(repeat.isExposure())
    assert.ok(repeat.isCacheHit())
    assert.ok(!repeat.shouldSend())

    assert.strictEqual(exposureChannel.publish.callCount, 1)
  })

  it('returns only HOOK features, read-only', async () => {
    const evaluations = []
    await OpenFeature.setProviderAndWait(provider)
    const client = OpenFeature.getClient()
    client.addHooks(new ExposureHook(evaluation => evaluations.push(evaluation)))

    await client.getBooleanDetails('holdout-flag', true, { targetingKey: 'subject-1' })

    assert.deepStrictEqual(evaluations[0].getFeatures(), {
      'holdout.key': '06ad',
      'holdout.assignment_group': 'status_quo',
      'holdout.should_include_in_holdout_analysis': false,
    })
    assert.throws(() => { evaluations[0].getFeatures()['holdout.key'] = 'mutated' })
  })

  it('never reports a failed or non-logging evaluation as an exposure', async () => {
    const evaluations = []
    await OpenFeature.setProviderAndWait(provider)
    const client = OpenFeature.getClient()
    client.addHooks(new ExposureHook(evaluation => evaluations.push(evaluation)))

    const missing = await client.getBooleanDetails('missing-flag', true, { targetingKey: 'subject-1' })
    assert.strictEqual(missing.errorCode, 'FLAG_NOT_FOUND')
    assert.ok(!evaluations[0].isExposure())
    assert.ok(!evaluations[0].isCacheHit())
    assert.ok(!evaluations[0].shouldSend())
    assert.deepStrictEqual(evaluations[0].getFeatures(), {})
    assert.strictEqual(exposureChannel.publish.callCount, 0)

    const wrongType = await client.getStringDetails('holdout-flag', 'default', { targetingKey: 'subject-1' })
    assert.strictEqual(wrongType.errorCode, 'TYPE_MISMATCH')
    assert.ok(!evaluations[1].isExposure())
    assert.strictEqual(exposureChannel.publish.callCount, 0)
  })

  it('keeps the evaluation unaffected when the callback throws', async () => {
    let calls = 0
    const throwingHook = new ExposureHook(() => {
      calls++
      throw new Error('customer callback failed')
    })
    await OpenFeature.setProviderAndWait(provider)
    const client = OpenFeature.getClient()
    client.addHooks(throwingHook)

    const result = await client.getBooleanDetails('holdout-flag', true, { targetingKey: 'subject-1' })
    assert.strictEqual(result.value, false)
    assert.strictEqual(result.errorCode, undefined)

    await client.getBooleanDetails('holdout-flag', true, { targetingKey: 'subject-1' })
    assert.strictEqual(calls, 2)
    sinon.assert.calledOnce(log.warn)
    sinon.assert.calledOnce(log.debug)
    sinon.assert.calledWith(log.warn, sinon.match('Exposure callback failed'), sinon.match.instanceOf(Error))
  })

  it('requires a callback function', () => {
    assert.throws(() => new ExposureHook(), /callback/)
  })

  it('keeps working when the evaluation context is unreadable', async () => {
    const evaluations = []
    const hook = new ExposureHook(evaluation => evaluations.push(evaluation))
    await OpenFeature.setProviderAndWait(provider)
    const client = OpenFeature.getClient()
    client.addHooks(hook)

    await client.getBooleanDetails('holdout-flag', true, { targetingKey: 'subject-1' })

    // Drive the hook directly with a hostile hookContext, as another wrapper could produce.
    hook.finally({ flagKey: 'holdout-flag', get context () { throw new Error('unreadable') } },
      await provider.resolveBooleanEvaluation('holdout-flag', true, { targetingKey: 'subject-2' }, log))

    assert.strictEqual(evaluations.length, 2)
    assert.strictEqual(evaluations[1].targetingKey, undefined)
    assert.strictEqual(evaluations[1].context, undefined)
    assert.ok(evaluations[1].isExposure())
  })

  it('never reports an error result as an exposure, even when it still carries exposure metadata', () => {
    const evaluations = []
    const hook = new ExposureHook(evaluation => evaluations.push(evaluation))

    hook.finally(
      { flagKey: 'holdout-flag', context: { targetingKey: 'subject-1' } },
      {
        flagKey: 'holdout-flag',
        value: true,
        variant: 'control',
        errorCode: 'GENERAL',
        flagMetadata: {
          __dd_allocation_key: 'holdout-allocation',
          __dd_do_log: true,
          __dd_exposure_cache_hit: false,
        },
      }
    )

    assert.ok(!evaluations[0].isExposure())
    assert.ok(!evaluations[0].isCacheHit())
    assert.ok(!evaluations[0].shouldSend())
  })

  it('does not invoke the callback without evaluation details', () => {
    const callback = sinon.spy()
    const hook = new ExposureHook(callback)
    hook.finally({ flagKey: 'holdout-flag', context: {} }, undefined)
    sinon.assert.notCalled(callback)
  })

  it('is reachable from the public entrypoint', () => {
    const publicHook = require('../../../../openfeature/exposure-hook')
    assert.strictEqual(typeof publicHook.ExposureHook, 'function')
  })
})
