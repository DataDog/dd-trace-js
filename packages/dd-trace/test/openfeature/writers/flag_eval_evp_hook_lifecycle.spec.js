'use strict'

const assert = require('node:assert/strict')

const { OpenFeature, InMemoryProvider } = require('@openfeature/server-sdk')
const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')

require('../../setup/core')

const FlagEvalEVPHook = require('../../../src/openfeature/writers/flag_eval_evp_hook')

// Proves the EVP hook actually fires through the REAL OpenFeature server-SDK evaluation
// lifecycle (not just a unit call of finally() in isolation), and that it covers the
// success, error, and runtime-default exit paths.
describe('FlagEvalEVPHook - real OpenFeature eval-path lifecycle', () => {
  let writer
  let hook
  let client

  const flags = {
    'bool-flag': { variants: { on: true, off: false }, defaultVariant: 'on', disabled: false },
  }

  beforeEach(async () => {
    writer = { enqueue: sinon.spy() }
    hook = new FlagEvalEVPHook(writer)

    await OpenFeature.setProviderAndWait(new InMemoryProvider(flags))
    client = OpenFeature.getClient()
    client.addHooks(hook)
  })

  afterEach(async () => {
    await OpenFeature.close()
  })

  it('fires on the SUCCESS path of a real evaluation and captures the resolved variant', async () => {
    const value = await client.getBooleanValue('bool-flag', false)
    assert.strictEqual(value, true)

    sinon.assert.calledOnce(writer.enqueue)
    const event = writer.enqueue.firstCall.args[0]
    assert.strictEqual(event.flagKey, 'bool-flag')
    assert.strictEqual(event.variant, 'on', 'success path captures the matched variant')
    assert.ok(!Object.hasOwn(event, 'reason'), 'OpenFeature reason is not an EVP field')
  })

  it('fires on the ERROR path (type mismatch) of a real evaluation', async () => {
    // Requesting a string from a boolean flag is a type-mismatch error handled by the SDK.
    const value = await client.getStringValue('bool-flag', 'fallback')
    assert.strictEqual(value, 'fallback')

    sinon.assert.calledOnce(writer.enqueue)
    const event = writer.enqueue.firstCall.args[0]
    assert.strictEqual(event.flagKey, 'bool-flag')
    assert.ok(!Object.hasOwn(event, 'reason'), 'error path must still omit OpenFeature reason')
    assert.strictEqual(event.variant, '', 'no variant on the error path → runtime_default')
  })

  it('fires on the DEFAULT path (flag not found) of a real evaluation', async () => {
    const value = await client.getBooleanValue('missing-flag', true)
    assert.strictEqual(value, true)

    sinon.assert.calledOnce(writer.enqueue)
    const event = writer.enqueue.firstCall.args[0]
    assert.strictEqual(event.flagKey, 'missing-flag')
    assert.strictEqual(event.variant, '', 'flag-not-found returns the caller default → runtime_default')
  })

  it('propagates the targetingKey from the real evaluation context', async () => {
    await client.getBooleanValue('bool-flag', false, { targetingKey: 'user-42' })

    sinon.assert.calledOnce(writer.enqueue)
    assert.strictEqual(writer.enqueue.firstCall.args[0].targetingKey, 'user-42')
  })
})
