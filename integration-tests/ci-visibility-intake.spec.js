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

  it('runs the assertion once after child exit + grace and resolves on success', async () => {
    const child = fakeChildProcess()
    const promise = intake.gatherPayloadsUntilChildExit(
      child,
      ({ url }) => url === '/api/v2/citestcycle',
      (payloads) => {
        assert.strictEqual(payloads.length, 3)
      },
      { gracePeriod: 50, hardTimeout: 5000 }
    )

    intake.emit('message', { url: '/api/v2/citestcycle', payload: { i: 1 } })
    intake.emit('message', { url: '/api/v2/citestcycle', payload: { i: 2 } })
    intake.emit('message', { url: '/api/v2/citestcycle', payload: { i: 3 } })
    child.simulateExit(0)

    await promise
  })

  it('does not resolve before child exit, even when the buffer would satisfy the assertion', async () => {
    const child = fakeChildProcess()
    let assertionRuns = 0
    const promise = intake.gatherPayloadsUntilChildExit(
      child,
      ({ url }) => url === '/api/v2/citestcycle',
      (payloads) => {
        assertionRuns += 1
        assert.strictEqual(payloads.length, 1)
      },
      { gracePeriod: 50, hardTimeout: 5000 }
    )

    intake.emit('message', { url: '/api/v2/citestcycle', payload: { i: 1 } })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.strictEqual(assertionRuns, 0, 'onPayload must not run before child exit')

    child.simulateExit(0)
    await promise
    assert.strictEqual(assertionRuns, 1, 'onPayload runs exactly once on the post-exit buffer')
  })

  it('picks up payloads that arrive during the grace period after child exit', async () => {
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

  it('rejects with the caller assertion error when the post-exit buffer fails the assertion', async () => {
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

  it('rejects with a hard-timeout error when the child neither exits nor produces payloads', async () => {
    const child = fakeChildProcess()
    const promise = intake.gatherPayloadsUntilChildExit(
      child,
      () => false,
      () => {},
      { gracePeriod: 50, hardTimeout: 100 }
    )

    await assert.rejects(promise, /hard timeout of 100ms/)
  })

  it('does not surface a hard-timeout error when the child exits just before the backstop', async () => {
    const child = fakeChildProcess()
    const promise = intake.gatherPayloadsUntilChildExit(
      child,
      ({ url }) => url === '/api/v2/citestcycle',
      (payloads) => {
        assert.strictEqual(payloads.length, 1)
      },
      { gracePeriod: 50, hardTimeout: 100 }
    )

    setTimeout(() => {
      intake.emit('message', { url: '/api/v2/citestcycle', payload: {} })
      child.simulateExit(0)
    }, 80)

    await promise
  })

  it('treats a child that already exited as exit + grace', async () => {
    const child = fakeChildProcess()
    child.exitCode = 0

    intake.emit('message', { url: '/api/v2/citestcycle', payload: {} })

    const promise = intake.gatherPayloadsUntilChildExit(
      child,
      ({ url }) => url === '/api/v2/citestcycle',
      () => assert.fail('pre-subscribe payloads must not be captured'),
      { gracePeriod: 50, hardTimeout: 5000 }
    )

    await assert.rejects(promise, /child exited with no matching payloads/)
  })
})
