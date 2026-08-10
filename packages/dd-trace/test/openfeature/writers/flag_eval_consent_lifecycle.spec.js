'use strict'

const assert = require('node:assert/strict')

const { OpenFeature, InMemoryProvider } = require('@openfeature/server-sdk')
const { describe, it, beforeEach, afterEach } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../setup/core')

const FlagEvalEVPHook = require('../../../src/openfeature/writers/flag_eval_evp_hook')

// The single most important regression test in this PR: the Java pilot shipped a
// flush-time consent read bug that unit tests missed and system-tests (L3) caught.
// The bug shape: evaluation fires under consent X, a Remote Config update flips
// consent to !X before the flush timer fires, and the flushed event carries !X's
// wire shape instead of X's. Both directions produce PII bugs — consent-off traffic
// emitted raw, or consent-on traffic needlessly hashed.
//
// This spec drives the REAL hook + REAL writer through the OpenFeature server SDK
// and swaps consent between evaluation and flush to prove the design property:
// consent is read once at hook entry, stamped onto the event, and never re-read.
describe('FlagEvalEVPHook + FlagEvaluationsWriter — consent-lifecycle guard', () => {
  let FlagEvaluationsWriter
  let writer
  let hook
  let client
  let request
  let clock
  let getConsent
  let consentValue

  const config = {
    site: 'datadoghq.com',
    hostname: 'localhost',
    port: 8126,
    url: new URL('http://localhost:8126'),
    apiKey: 'test-api-key',
    service: 'test-service',
    version: '1.0.0',
    env: 'test',
  }

  const flags = {
    'bool-flag': { variants: { on: true, off: false }, defaultVariant: 'on', disabled: false },
  }

  beforeEach(async () => {
    request = sinon.stub().yieldsAsync(null, 'OK', 200)
    clock = sinon.useFakeTimers()

    FlagEvaluationsWriter = proxyquire('../../../src/openfeature/writers/flag_evaluations', {
      '../../log': { debug: () => {}, error: () => {}, warn: () => {} },
      '../../telemetry/metrics': {
        manager: { namespace: () => ({ count: () => ({ inc: () => {} }) }) },
      },
      './base': proxyquire('../../../src/openfeature/writers/base', {
        '../../exporters/common/request': request,
        '../../log': { debug: () => {}, error: () => {}, warn: () => {} },
      }),
    })

    writer = new FlagEvaluationsWriter(config)

    // Mutable consent accessor — the test flips consentValue between evaluate and flush.
    consentValue = true
    getConsent = () => consentValue
    hook = new FlagEvalEVPHook(writer, getConsent)

    await OpenFeature.setProviderAndWait(new InMemoryProvider(flags))
    client = OpenFeature.getClient()
    client.addHooks(hook)
  })

  afterEach(async () => {
    await OpenFeature.close()
    writer.destroy()
    clock.restore()
  })

  it('off→on swap: consent-off evaluation stays hashed even if consent flips on before flush', async () => {
    // Evaluate under consent OFF.
    consentValue = false
    await client.getBooleanValue('bool-flag', false, {
      targetingKey: 'jane.doe@datadoghq.com',
      plan: 'premium',
    })

    // Simulate an RC update flipping consent to ON before the flush timer fires.
    consentValue = true

    writer.flush()

    sinon.assert.calledOnce(request)
    const payload = JSON.parse(request.getCall(0).args[0])
    const event = payload.flagEvaluations[0]

    assert.strictEqual(
      event.targeting_key,
      'sha256_b4698f9b6d186781fa8dc59e533578fa2d8379a46b1cf6db85cda6aa9c99e51b',
      'evaluation-time consent (off) must win over the post-swap consent (on)'
    )
    assert.strictEqual(Object.hasOwn(event, 'context'), false,
      'evaluation-time context omission must win over the post-swap consent-on state')
  })

  it('on→off swap: consent-on evaluation stays raw even if consent flips off before flush', async () => {
    // Evaluate under consent ON.
    consentValue = true
    await client.getBooleanValue('bool-flag', false, {
      targetingKey: 'jane.doe@datadoghq.com',
      plan: 'premium',
    })

    // Simulate an RC update flipping consent to OFF before the flush timer fires.
    consentValue = false

    writer.flush()

    const payload = JSON.parse(request.getCall(0).args[0])
    const event = payload.flagEvaluations[0]

    assert.strictEqual(event.targeting_key, 'jane.doe@datadoghq.com',
      'evaluation-time consent (on) must preserve the raw targeting_key through flush')
    assert.deepStrictEqual(event.context, { evaluation: { plan: 'premium' } },
      'evaluation-time context capture must survive a post-evaluation consent-off swap')
  })

  it('multiple consent transitions during aggregation preserve each evaluation-time snapshot', async () => {
    // Two evaluations under different consent values, then flush. Both must reach
    // the wire with their own evaluation-time shape, in distinct buckets.
    consentValue = false
    await client.getBooleanValue('bool-flag', false, {
      targetingKey: 'jane.doe@datadoghq.com',
    })

    consentValue = true
    await client.getBooleanValue('bool-flag', false, {
      targetingKey: 'jane.doe@datadoghq.com',
    })

    // Post-eval swap must not retroactively apply.
    consentValue = false

    writer.flush()

    const payload = JSON.parse(request.getCall(0).args[0])
    assert.strictEqual(payload.flagEvaluations.length, 2)

    const targetingKeys = payload.flagEvaluations.map(e => e.targeting_key)
    assert.ok(targetingKeys.includes('jane.doe@datadoghq.com'),
      'consent-on evaluation preserves the raw targeting key')
    assert.ok(targetingKeys.includes(
      'sha256_b4698f9b6d186781fa8dc59e533578fa2d8379a46b1cf6db85cda6aa9c99e51b'),
    'consent-off evaluation carries the hashed targeting key')
  })
})
