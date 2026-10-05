'use strict'

const assert = require('node:assert/strict')

const { before, describe, it } = require('mocha')
const { channel } = require('dc-polyfill')

require('../src/aws-sdk')

const SMITHY_HOOK = globalThis[Symbol.for('_ddtrace_instrumentations')]['@smithy/smithy-client'][0].hook
const AWS_SMITHY_HOOK = globalThis[Symbol.for('_ddtrace_instrumentations')]['@aws-sdk/smithy-client'][0].hook
const SMITHY_CORE_HOOK = globalThis[Symbol.for('_ddtrace_instrumentations')]['@smithy/core'][0].hook

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

describe('aws-sdk instrumentation: shared Smithy clients', () => {
  const hookOrders = [
    ['core first', [SMITHY_CORE_HOOK, SMITHY_HOOK, AWS_SMITHY_HOOK]],
    ['smithy first', [SMITHY_HOOK, AWS_SMITHY_HOOK, SMITHY_CORE_HOOK]],
    ['aws first', [AWS_SMITHY_HOOK, SMITHY_CORE_HOOK, SMITHY_HOOK]],
  ]

  for (const [order, hooks] of hookOrders) {
    for (const mode of ['promise', 'callback', 'callback with options']) {
      for (const failing of [false, true]) {
        it(`publishes once per ${failing ? 'failed' : 'successful'} ${mode} request with ${order}`, async () => {
          const error = new Error('request failed')
          const output = { Account: '123456789012' }
          const options = { requestTimeout: 100 }
          let calls = 0

          class Client {
            constructor () {
              this.config = { serviceId: 'STS', region: () => Promise.resolve('us-east-1') }
            }

            /**
             * @param {{ input: object }} command
             * @param {object | ((error: Error | null, result?: object) => void)} [optionsOrCb]
             * @param {(error: Error | null, result?: object) => void} [cb]
             */
            send (command, optionsOrCb, cb) {
              calls++
              assert.deepStrictEqual(command.input, {})
              if (mode === 'callback with options') assert.strictEqual(optionsOrCb, options)
              const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb
              const result = failing ? Promise.reject(error) : Promise.resolve(output)
              if (!callback) return result
              result.then(value => callback(null, value), callback)
            }
          }

          for (const hook of hooks) {
            const exports = { Client }
            assert.strictEqual(hook(exports), exports)
          }

          const starts = []
          const completions = []
          const start = channel('apm:aws:request:start:aws')
          const complete = channel('apm:aws:request:complete:aws')
          const onStart = ctx => starts.push(ctx)
          const onComplete = ctx => completions.push(ctx)
          start.subscribe(onStart)
          complete.subscribe(onComplete)

          try {
            const client = new Client()
            for (let i = 0; i < 2; i++) {
              const command = { input: {} }
              const request = mode === 'promise'
                ? client.send(command)
                : new Promise((resolve, reject) => {
                  const callback = (err, result) => err ? reject(err) : resolve(result)
                  if (mode === 'callback') client.send(command, callback)
                  else client.send(command, options, callback)
                })
              if (failing) await assert.rejects(request, error)
              else assert.strictEqual(await request, output)
            }
            assert.strictEqual(calls, 2)
            assert.strictEqual(starts.length, 2)
            assert.deepStrictEqual(completions, starts)
            for (const ctx of completions) {
              assert.strictEqual(ctx.response.error, failing ? error : null)
            }
          } finally {
            start.unsubscribe(onStart)
            complete.unsubscribe(onComplete)
          }
        })
      }
    }
  }

  it('instruments separate copies of the SDK', async () => {
    const FirstClient = makeFakeClientClass('STS')
    const SecondClient = makeFakeClientClass('STS')
    SMITHY_CORE_HOOK({ Client: FirstClient })
    SMITHY_CORE_HOOK({ Client: SecondClient })

    const requests = []
    const start = channel('apm:aws:request:start:aws')
    const onStart = ctx => requests.push(ctx)
    start.subscribe(onStart)
    try {
      await Promise.all([new FirstClient().send({ input: {} }), new SecondClient().send({ input: {} })])
      assert.strictEqual(requests.length, 2)
      assert.notStrictEqual(requests[0].request, requests[1].request)
    } finally {
      start.unsubscribe(onStart)
    }
  })
})

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

describe('aws-sdk instrumentation: channel suffix', () => {
  /**
   * Send one command through a smithy client reporting `serviceId` and return the suffix of the
   * `apm:aws:request:start:*` channel it published on.
   *
   * @param {string} serviceId
   */
  async function suffixFor (serviceId) {
    const candidates = ['eventbridge', 'aws', 'default', 'sns']
    const seen = []
    const listeners = candidates.map(suffix => {
      const listener = () => seen.push(suffix)
      channel(`apm:aws:request:start:${suffix}`).subscribe(listener)
      return { suffix, listener }
    })

    try {
      const command = { input: {} }
      command.deserialize = () => ({})
      await new (makeFakeClientClass(serviceId))().send(command)
    } finally {
      for (const { suffix, listener } of listeners) {
        channel(`apm:aws:request:start:${suffix}`).unsubscribe(listener)
      }
    }

    return seen
  }

  it('routes a known service to its own channel', async () => {
    assert.deepStrictEqual(await suffixFor('SNS'), ['sns'])
  })

  it('routes the legacy CloudWatch Events service id to the eventbridge channel', async () => {
    assert.deepStrictEqual(await suffixFor('CloudWatch Events'), ['eventbridge'])
  })

  it('routes the events endpoint prefix to the eventbridge channel', async () => {
    assert.deepStrictEqual(await suffixFor('events'), ['eventbridge'])
  })

  it('routes an unknown service to the aws channel', async () => {
    assert.deepStrictEqual(await suffixFor('Timestream Write'), ['aws'])
  })
})
