'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const { FakeCiVisIntake } = require('./ci-visibility-intake')

function fakeChildProcess () {
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.simulateExit = (code = 0) => {
    child.exitCode = code
    child.emit('exit', code, null)
  }
  return child
}

describe('FakeCiVisIntake.gatherPayloadsUntilChildExit', () => {
  let intake

  beforeEach(async () => {
    intake = await new FakeCiVisIntake().start()
  })

  afterEach(() => intake.stop())

  it('resolves immediately when the caller assertion passes on an early payload', async () => {
    const child = fakeChildProcess()
    const promise = intake.gatherPayloadsUntilChildExit(
      child,
      ({ url }) => url === '/api/v2/citestcycle',
      (payloads) => {
        assert.strictEqual(payloads.length, 1)
      },
      { gracePeriod: 50, hardTimeout: 5000 }
    )

    intake.emit('message', { url: '/api/v2/citestcycle', payload: {} })

    await promise
  })

  it('resolves after child exit + grace when the assertion only passes once all events are in', async () => {
    const child = fakeChildProcess()
    const promise = intake.gatherPayloadsUntilChildExit(
      child,
      ({ url }) => url === '/api/v2/citestcycle',
      (payloads) => {
        assert.strictEqual(payloads.length, 3, 'expected exactly three payloads')
      },
      { gracePeriod: 50, hardTimeout: 5000 }
    )

    intake.emit('message', { url: '/api/v2/citestcycle', payload: { i: 1 } })
    intake.emit('message', { url: '/api/v2/citestcycle', payload: { i: 2 } })
    intake.emit('message', { url: '/api/v2/citestcycle', payload: { i: 3 } })
    child.simulateExit(0)

    await promise
  })

  it('still picks up payloads that arrive during the grace period after child exit', async () => {
    const child = fakeChildProcess()
    const promise = intake.gatherPayloadsUntilChildExit(
      child,
      ({ url }) => url === '/api/v2/citestcycle',
      (payloads) => {
        assert.strictEqual(payloads.length, 2)
      },
      { gracePeriod: 100, hardTimeout: 5000 }
    )

    intake.emit('message', { url: '/api/v2/citestcycle', payload: { i: 1 } })
    child.simulateExit(0)
    setImmediate(() => {
      intake.emit('message', { url: '/api/v2/citestcycle', payload: { i: 2 } })
    })

    await promise
  })

  it('rejects with a clear error when the child exits without any matching payloads', async () => {
    const child = fakeChildProcess()
    const promise = intake.gatherPayloadsUntilChildExit(
      child,
      () => false,
      () => assert.fail('onPayload must not run when no payloads matched'),
      { gracePeriod: 50, hardTimeout: 5000 }
    )

    child.simulateExit(1)

    await assert.rejects(promise, /child exited with no matching payloads/)
  })

  it('rejects with the caller assertion error when payloads arrived but the assertion fails', async () => {
    const child = fakeChildProcess()
    const promise = intake.gatherPayloadsUntilChildExit(
      child,
      ({ url }) => url === '/api/v2/citestcycle',
      (payloads) => {
        assert.strictEqual(payloads.length, 5, 'expected five payloads')
      },
      { gracePeriod: 50, hardTimeout: 5000 }
    )

    intake.emit('message', { url: '/api/v2/citestcycle', payload: { i: 1 } })
    child.simulateExit(0)

    await assert.rejects(promise, /expected five payloads/)
  })

  it('rejects with a hard-timeout error when the child neither exits nor satisfies the assertion', async () => {
    const child = fakeChildProcess()
    const promise = intake.gatherPayloadsUntilChildExit(
      child,
      () => false,
      () => {},
      { gracePeriod: 50, hardTimeout: 100 }
    )

    await assert.rejects(promise, /hard timeout of 100ms/)
  })

  it('treats a child that already exited as exit + grace, with no pre-subscribe payloads', async () => {
    const child = fakeChildProcess()
    child.exitCode = 0

    intake.emit('message', { url: '/api/v2/citestcycle', payload: {} })

    const promise = intake.gatherPayloadsUntilChildExit(
      child,
      ({ url }) => url === '/api/v2/citestcycle',
      () => assert.fail('onPayload must not run when no payloads matched'),
      { gracePeriod: 50, hardTimeout: 5000 }
    )

    await assert.rejects(promise, /child exited with no matching payloads/)
  })
})
