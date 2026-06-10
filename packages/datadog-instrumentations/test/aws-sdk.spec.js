'use strict'

const assert = require('node:assert/strict')

const { before, describe, it } = require('mocha')

require('../src/aws-sdk')

const SMITHY_HOOK = globalThis[Symbol.for('_ddtrace_instrumentations')]['@smithy/smithy-client'][0].hook

/**
 * Wrap a fresh `Client` class via the registered `@smithy/smithy-client` hook
 * and return it. Each test gets its own class so the instrumentation's
 * `WeakSet`s start empty for the prototype it cares about.
 *
 * @param {string} serviceId Suffix the wrapper feeds into the channel-name
 *   lookup; pick a unique one per test to keep diagnostic-channel state
 *   isolated.
 * @returns {Function}
 */
function makeFakeClientClass (serviceId) {
  class FakeClient {
    constructor () {
      this.config = {
        serviceId,
        region: () => Promise.resolve('us-east-1'),
      }
    }

    send () {
      return Promise.resolve({})
    }
  }

  SMITHY_HOOK({ Client: FakeClient })
  return FakeClient
}

describe('aws-sdk instrumentation: smithy command-deserialize patching', () => {
  before(() => {
    assert.equal(typeof SMITHY_HOOK, 'function', 'smithy hook should register on require')
  })

  it('wraps the Command prototype once across multiple instances of the same class', async () => {
    const FakeClient = makeFakeClientClass('kinesis')

    class StreamCommand {}
    function originalDeserialize () { return { body: 'parsed' } }
    StreamCommand.prototype.deserialize = originalDeserialize

    const client = new FakeClient()
    const c1 = new StreamCommand()
    c1.input = {}
    const c2 = new StreamCommand()
    c2.input = {}

    await client.send(c1)
    const wrappedDeserialize = StreamCommand.prototype.deserialize
    assert.notEqual(wrappedDeserialize, originalDeserialize, 'first send should wrap the prototype')

    await client.send(c2)
    assert.equal(
      StreamCommand.prototype.deserialize,
      wrappedDeserialize,
      'second send must not re-wrap the prototype'
    )

    assert.equal(Object.hasOwn(c1, 'deserialize'), false)
    assert.equal(Object.hasOwn(c2, 'deserialize'), false)
  })

  it('wraps own-property deserialize per instance and leaves the prototype untouched', async () => {
    const FakeClient = makeFakeClientClass('sqs')

    class QueueCommand {}
    function protoDeserialize () { return { body: 'proto' } }
    QueueCommand.prototype.deserialize = protoDeserialize

    function ownC1 () { return { body: 'own1' } }
    function ownC2 () { return { body: 'own2' } }

    const client = new FakeClient()
    const c1 = new QueueCommand()
    c1.input = {}
    c1.deserialize = ownC1

    const c2 = new QueueCommand()
    c2.input = {}
    c2.deserialize = ownC2

    await client.send(c1)
    await client.send(c2)

    assert.equal(QueueCommand.prototype.deserialize, protoDeserialize)
    assert.notEqual(c1.deserialize, ownC1)
    assert.notEqual(c2.deserialize, ownC2)
    assert.notEqual(c1.deserialize, c2.deserialize)
  })
})
