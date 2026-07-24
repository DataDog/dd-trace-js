'use strict'

const assert = require('node:assert/strict')

const { describe, it, afterEach } = require('mocha')
const sinon = require('sinon')

require('../setup/core')

const {
  FlushCoordinator,
  OUTCOME_DISABLED,
  OUTCOME_HANDED_OFF,
  OUTCOME_EMPTY,
  OUTCOME_FAILED,
  OUTCOME_TIMED_OUT,
  channels,
} = require('../../src/serverless/index')

describe('serverless FlushCoordinator', () => {
  const subscriptions = []

  afterEach(() => {
    for (const { channel, handler } of subscriptions.splice(0)) {
      channel.unsubscribe(handler)
    }
    sinon.restore()
  })

  it('reports handed off when the exporter flush callback succeeds', () => {
    const starts = []
    const handedOff = []
    record(channels.flushStart, starts)
    record(channels.flushHandedOff, handedOff)

    const exporter = { flush: sinon.stub().callsArg(0) }
    const coordinator = new FlushCoordinator({ _exporter: exporter })
    let result

    coordinator.flush({ reason: 'finish', token: 'abc' }, value => {
      result = value
    })

    sinon.assert.calledOnce(exporter.flush)
    assert.strictEqual(result.outcome, OUTCOME_HANDED_OFF)
    assert.strictEqual(handedOff[0].outcome, OUTCOME_HANDED_OFF)
    assert.deepStrictEqual(starts[0], { reason: 'finish', token: 'abc', source: undefined })
  })

  it('reports disabled when no exporter flush is available', () => {
    const disabled = []
    record(channels.flushDisabled, disabled)

    const coordinator = new FlushCoordinator({})
    let result

    coordinator.flush({}, value => {
      result = value
    })

    assert.strictEqual(result.outcome, OUTCOME_DISABLED)
    assert.strictEqual(disabled[0].outcome, OUTCOME_DISABLED)
  })

  it('reports empty without calling exporter flush when the buffer is empty', () => {
    const empty = []
    record(channels.flushEmpty, empty)

    const exporter = { flush: sinon.stub() }
    const coordinator = new FlushCoordinator({ _exporter: exporter }, { isEmpty: () => true })
    let result

    coordinator.flush({}, value => {
      result = value
    })

    sinon.assert.notCalled(exporter.flush)
    assert.strictEqual(result.outcome, OUTCOME_EMPTY)
    assert.strictEqual(empty[0].outcome, OUTCOME_EMPTY)
  })

  it('reports timed out when the exporter does not complete before the deadline', () => {
    const clock = sinon.useFakeTimers()
    const timeouts = []
    record(channels.flushTimedOut, timeouts)

    const exporter = { flush: sinon.stub() }
    const coordinator = new FlushCoordinator({ _exporter: exporter })
    let result

    coordinator.flush({ deadlineMs: Date.now() + 10 }, value => {
      result = value
    })
    clock.tick(10)

    assert.strictEqual(result.outcome, OUTCOME_TIMED_OUT)
    assert.strictEqual(timeouts[0].outcome, OUTCOME_TIMED_OUT)
  })

  it('reports timed out immediately when the deadline has expired', () => {
    const clock = sinon.useFakeTimers({ now: 100 })
    const exporter = { flush: sinon.stub() }
    const coordinator = new FlushCoordinator({ _exporter: exporter })
    let result

    coordinator.flush({ deadlineMs: 100 }, value => {
      result = value
    })

    sinon.assert.notCalled(exporter.flush)
    assert.strictEqual(result.outcome, OUTCOME_TIMED_OUT)
    clock.restore()
  })

  it('ignores exporter completion after the deadline outcome', () => {
    const clock = sinon.useFakeTimers()
    const exporter = { flush: sinon.stub() }
    const coordinator = new FlushCoordinator({ _exporter: exporter })
    const done = sinon.spy()

    coordinator.flush({ deadlineMs: Date.now() + 10 }, done)
    clock.tick(10)
    exporter.flush.firstCall.args[0]()

    sinon.assert.calledOnce(done)
    assert.strictEqual(done.firstCall.args[0].outcome, OUTCOME_TIMED_OUT)
  })

  it('reports failed when exporter flush throws', () => {
    const errors = []
    record(channels.flushFailed, errors)

    const error = new Error('flush failed')
    const exporter = {
      flush: sinon.stub().throws(error),
    }
    const coordinator = new FlushCoordinator({ _exporter: exporter })
    let result

    coordinator.flush({}, value => {
      result = value
    })

    assert.strictEqual(result.outcome, OUTCOME_FAILED)
    assert.strictEqual(result.error, error)
    assert.strictEqual(errors[0].error, error)
  })

  it('reports failed when the exporter callback receives an error', () => {
    const error = new Error('flush failed')
    const exporter = { flush: sinon.stub().callsArgWith(0, error) }
    const coordinator = new FlushCoordinator({ _exporter: exporter })
    let result

    coordinator.flush({}, value => {
      result = value
    })

    assert.strictEqual(result.outcome, OUTCOME_FAILED)
    assert.strictEqual(result.error, error)
  })

  function record (channel, events) {
    const handler = event => events.push(event)
    subscriptions.push({ channel, handler })
    channel.subscribe(handler)
  }
})
