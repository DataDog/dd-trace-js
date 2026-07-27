'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const sinon = require('sinon')

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
  let clock, intake

  beforeEach(async () => {
    intake = await new FakeCiVisIntake().start()
    clock = sinon.useFakeTimers()
  })

  afterEach(() => {
    clock.restore()
    return intake.stop()
  })

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

    await Promise.all([clock.tickAsync(50), promise])
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
    await clock.tickAsync(100)
    assert.strictEqual(assertionRuns, 0, 'onPayload must not run before child exit')

    child.simulateExit(0)
    await Promise.all([clock.tickAsync(50), promise])
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

    await Promise.all([clock.tickAsync(100), promise])
  })

  it('fails when a valid prefix is followed by a duplicate during the grace period', async () => {
    const child = fakeChildProcess()
    const promise = intake.gatherPayloadsUntilChildExit(
      child,
      ({ url }) => url === '/api/v2/citestcycle',
      (payloads) => {
        assert.strictEqual(payloads.length, 1, 'expected exactly one payload')
      },
      { gracePeriod: 50, hardTimeout: 5000 }
    )
    const rejection = assert.rejects(promise, /expected exactly one payload/)

    intake.emit('message', { url: '/api/v2/citestcycle', payload: { i: 1 } })
    child.simulateExit(0)
    setImmediate(() => {
      intake.emit('message', { url: '/api/v2/citestcycle', payload: { i: 1 } })
    })

    await Promise.all([clock.tickAsync(50), rejection])
  })

  it('rejects with a clear error when the child exits without any matching payloads', async () => {
    const child = fakeChildProcess()
    const promise = intake.gatherPayloadsUntilChildExit(
      child,
      () => false,
      () => assert.fail('onPayload must not run when no payloads matched'),
      { gracePeriod: 50, hardTimeout: 5000 }
    )
    const rejection = assert.rejects(promise, /child exited with no matching payloads/)

    child.simulateExit(1)

    await Promise.all([clock.tickAsync(50), rejection])
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
    const rejection = assert.rejects(promise, /expected five payloads/)

    intake.emit('message', { url: '/api/v2/citestcycle', payload: { i: 1 } })
    child.simulateExit(0)

    await Promise.all([clock.tickAsync(50), rejection])
  })

  it('settles once on hard timeout when the child does not exit', async () => {
    const child = fakeChildProcess()
    let assertionRuns = 0
    const promise = intake.gatherPayloadsUntilChildExit(
      child,
      () => false,
      () => {
        assertionRuns += 1
      },
      { gracePeriod: 50, hardTimeout: 100 }
    )
    const rejection = assert.rejects(promise, /hard timeout of 100ms/)

    await Promise.all([clock.tickAsync(100), rejection])

    child.simulateExit(0)
    intake.emit('message', { url: '/api/v2/citestcycle', payload: {} })
    await clock.tickAsync(50)

    assert.strictEqual(assertionRuns, 0)
    assert.strictEqual(intake.listenerCount('message'), 0)
    assert.strictEqual(child.listenerCount('exit'), 0)
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

    await Promise.all([clock.tickAsync(130), promise])
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
    const rejection = assert.rejects(promise, /child exited with no matching payloads/)

    await Promise.all([clock.tickAsync(50), rejection])
  })
})
