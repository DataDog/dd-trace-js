'use strict'

const assert = require('node:assert/strict')
const dgram = require('node:dgram')
const { EventEmitter } = require('node:events')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const log = require('../../../dd-trace/src/log')
const { LambdaDogStatsD } = require('../../src/metrics/dogstatsd')

describe('Lambda DogStatsD source contracts', () => {
  let clock, socket, callbacks, errorLog
  beforeEach(() => {
    clock = sinon.useFakeTimers()
    callbacks = []
    socket = new EventEmitter()
    socket.send = sinon.spy((...args) => callbacks.push(args.at(-1)))
    socket.unref = sinon.spy()
    sinon.stub(dgram, 'createSocket').returns(socket)
    errorLog = sinon.stub(log, 'error')
  })
  afterEach(() => sinon.restore())

  for (const [value, timestamp, tags, packet] of [
    [1, undefined, undefined, 'metric:1|d'],
    [2, 12345, ['tag1', 'bad?tag'], 'metric:2|d|#tag1,bad_tag|T12345'],
    [2, 12345.678, [], 'metric:2|d|T12345'],
    [0, 0, ['a/b:c.d-e_f', 'é,|\n'], 'metric:0|d|#a/b:c.d-e_f,____|T0'],
    [-1, -0.1, [], 'metric:-1|d|T-1'],
    [1, NaN, [], 'metric:1|d|TNaN'],
    [1, null, [], 'metric:1|d'],
  ]) {
    it(`sends exact distribution packet ${JSON.stringify(packet)}`, async () => {
      const client = new LambdaDogStatsD()
      client.distribution('metric', value, timestamp, tags)
      const message = Buffer.from(packet + '\n')
      sinon.assert.calledOnceWithExactly(socket.send, message, 0, message.length, 8125, '127.0.0.1', sinon.match.func)
      callbacks[0]()
      await client.flush()
    })
  }

  for (const value of [null, undefined]) {
    it(`ignores ${value} metric values`, async () => {
      const client = new LambdaDogStatsD()
      client.distribution('metric', value)
      await client.flush()
      sinon.assert.notCalled(socket.send)
    })
  }

  it('uses the shared client and unrefs its sockets', () => {
    const client = new LambdaDogStatsD()
    assert.ok(client)
    sinon.assert.calledWithExactly(dgram.createSocket, 'udp4')
    sinon.assert.calledWithExactly(dgram.createSocket, 'udp6')
    sinon.assert.calledTwice(socket.unref)
  })

  it('immediately resolves idle flushes without allocating timers', async () => {
    const client = new LambdaDogStatsD()
    const first = client.flush()
    assert.strictEqual(first, client.flush())
    assert.strictEqual(await first, undefined)
    assert.strictEqual(clock.countTimers(), 0)
  })

  it('waits for one send and clears its timeout', async () => {
    const client = new LambdaDogStatsD()
    client.distribution('metric', 1)
    const done = sinon.spy()
    const flush = client.flush().then(done)
    await Promise.resolve()
    sinon.assert.notCalled(done)
    callbacks[0]()
    await flush
    assert.strictEqual(clock.countTimers(), 0)
  })

  it('waits for every pending send', async () => {
    const client = new LambdaDogStatsD()
    for (let i = 0; i < 3; i++) client.distribution('metric', i)
    const done = sinon.spy()
    const flush = client.flush().then(done)
    callbacks[1]()
    callbacks[0]()
    await Promise.resolve()
    sinon.assert.notCalled(done)
    callbacks[2]()
    await flush
    sinon.assert.calledOnce(done)
  })

  it('includes new sends while a flush is pending and shares concurrent flushes', async () => {
    const client = new LambdaDogStatsD()
    client.distribution('first', 1)
    const first = client.flush()
    assert.strictEqual(client.flush(), first)
    const done = sinon.spy()
    const observed = first.then(done)
    client.distribution('second', 2)
    callbacks[0]()
    await Promise.resolve()
    sinon.assert.notCalled(done)
    callbacks[1]()
    await Promise.all([first, observed])
  })

  it('logs callback errors and completes the send', async () => {
    const client = new LambdaDogStatsD()
    client.distribution('metric', 1)
    const flush = client.flush()
    callbacks[0](new Error('callback failure'))
    await flush
    sinon.assert.calledWithExactly(errorLog, 'DogStatsDClient: UDP error', sinon.match({ message: 'callback failure' }))
    assert.strictEqual(clock.countTimers(), 0)
  })

  for (const error of [new Error('synchronous failure'), 'non-error failure']) {
    it(`contains synchronous send failures: ${error}`, async () => {
      socket.send = sinon.stub().throws(error)
      if (typeof error === 'string') socket.send = () => { throw error }
      const client = new LambdaDogStatsD()
      client.distribution('metric', 1)
      await client.flush()
      sinon.assert.calledWithExactly(errorLog, 'DogStatsDClient: UDP error sending metrics', error)
      assert.strictEqual(clock.countTimers(), 0)
    })
  }

  it('contains a socket error event while preserving callback completion', async () => {
    const client = new LambdaDogStatsD()
    client.distribution('metric', 1)
    const flush = client.flush()
    socket.emit('error', new Error('socket failure'))
    callbacks[0](new Error('socket failure'))
    await flush
    assert.strictEqual(clock.countTimers(), 0)
  })

  it('times out at 1000ms and ignores old callbacks after reuse', async () => {
    const client = new LambdaDogStatsD()
    client.distribution('old', 1)
    const done = sinon.spy()
    const oldFlush = client.flush().then(done)
    await clock.tickAsync(999)
    sinon.assert.notCalled(done)
    await clock.tickAsync(1)
    await oldFlush
    client.distribution('new', 2)
    const nextDone = sinon.spy()
    const newFlush = client.flush().then(nextDone)
    callbacks[0]()
    await Promise.resolve()
    sinon.assert.notCalled(nextDone)
    callbacks[1]()
    await newFlush
    sinon.assert.calledOnce(nextDone)
    assert.strictEqual(clock.countTimers(), 0)
  })
})
