'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const dgram = require('node:dgram')
const { EventEmitter, once } = require('node:events')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { addMetadata, addStepFunctionContext, addLambdaTriggerTags } = require('../src/xray')

const traceId = '1-5e272390-8c398be037738dc042009320'
const parentId = '94ae789b969f1cc5'
const header = `Root=${traceId};Parent=${parentId};Sampled=1`
const metadata = { test: 'metadata' }

// Source xray-service.spec.ts transport cases, exercised through the private sender's actual entry points.
describe('Lambda X-Ray metadata protocol', () => {
  const oldEnv = process.env
  let socket, createSocket, randomBytes

  beforeEach(() => {
    process.env = { ...oldEnv, _X_AMZN_TRACE_ID: header, AWS_XRAY_DAEMON_ADDRESS: 'localhost:127.0.0.1:2000' }
    sinon.useFakeTimers({ now: 1487076708000, toFake: ['Date'] })
    randomBytes = sinon.stub(crypto, 'randomBytes').returns('11111')
    socket = new EventEmitter()
    socket.send = sinon.stub().callsFake((message, start, length, port, address, callback) => callback(undefined, 1))
    socket.close = sinon.stub()
    createSocket = sinon.stub(dgram, 'createSocket').returns(socket)
  })

  afterEach(() => {
    sinon.restore()
    process.env = oldEnv
  })

  function sent () {
    const [message, offset, length, port, address] = socket.send.firstCall.args
    assert.ok(Buffer.isBuffer(message))
    assert.strictEqual(offset, 0)
    assert.strictEqual(length, message.length)
    assert.strictEqual(port, 127)
    assert.strictEqual(address, 'localhost')
    assert.strictEqual(createSocket.firstCall.args[0], 'udp4')
    assert.strictEqual(socket.close.callCount, 1)
    assert.strictEqual(socket.listenerCount('error'), 0)
    return message.toString()
  }

  it('adds the source metadata subsegment with its exact envelope and framing', () => {
    addMetadata(metadata)
    assert.strictEqual(sent(), '{"format": "json", "version": 1}\n' +
      '{"id":"11111","trace_id":"1-5e272390-8c398be037738dc042009320","parent_id":"94ae789b969f1cc5",' +
      '"name":"datadog-metadata","start_time":1487076708,"end_time":1487076708,"type":"subsegment",' +
      '"metadata":{"datadog":{"trace":{"test":"metadata"}}}}')
    assert.deepStrictEqual(randomBytes.firstCall.args, [8])
  })

  for (const [key, add] of [
    ['trace', addMetadata],
    ['root_span_metadata', addStepFunctionContext],
    ['lambda_function_tags', addLambdaTriggerTags],
  ]) {
    it(`writes ${key} without changing the caller's object`, () => {
      const value = { field: 'value', absent: undefined }
      add(value)
      const segment = JSON.parse(sent().split('\n')[1])
      assert.deepStrictEqual(segment.metadata, { datadog: { [key]: { field: 'value' } } })
      assert.deepStrictEqual(value, { field: 'value', absent: undefined })
    })
  }

  for (const traceHeader of [
    undefined, '', 'undefined', `Root=${traceId};Parent=${parentId};`, `Root=${traceId};`,
  ]) {
    it(`skips generation for an absent or malformed trace header: ${traceHeader}`, () => {
      if (traceHeader === undefined) delete process.env._X_AMZN_TRACE_ID
      else process.env._X_AMZN_TRACE_ID = traceHeader
      addMetadata(metadata)
      assert.strictEqual(randomBytes.callCount, 0)
      assert.strictEqual(createSocket.callCount, 0)
      assert.strictEqual(socket.close.callCount, 0)
    })
  }

  for (const sampled of ['0', '-1', '2', '', 'invalid']) {
    it(`discards subsegments when AWS sampling is ${JSON.stringify(sampled)}`, () => {
      process.env._X_AMZN_TRACE_ID = `Root=${traceId};Parent=${parentId};Sampled=${sampled}`
      addMetadata(metadata)
      assert.strictEqual(randomBytes.callCount, 0)
      assert.strictEqual(createSocket.callCount, 0)
    })
  }

  for (const sampled of ['1', '01', '1suffix']) {
    it(`retains the source parseInt sampling predicate for ${sampled}`, () => {
      process.env._X_AMZN_TRACE_ID = `Root=${traceId};Parent=${parentId};Sampled=${sampled}`
      addMetadata(metadata)
      assert.strictEqual(socket.send.callCount, 1)
    })
  }

  for (const daemon of [undefined, '', 'localhost']) {
    it(`skips sending when the daemon is absent or has no port field: ${daemon}`, () => {
      if (daemon === undefined) delete process.env.AWS_XRAY_DAEMON_ADDRESS
      else process.env.AWS_XRAY_DAEMON_ADDRESS = daemon
      addMetadata(metadata)
      assert.strictEqual(createSocket.callCount, 0)
      assert.strictEqual(socket.close.callCount, 0)
    })
  }

  it('preserves source permissive ID parsing for metadata rather than applying extraction ID validation', () => {
    process.env._X_AMZN_TRACE_ID = 'Root=short;Parent=short;Sampled=1'
    addMetadata(metadata)
    const segment = JSON.parse(sent().split('\n')[1])
    assert.strictEqual(segment.trace_id, 'short')
    assert.strictEqual(segment.parent_id, 'short')
  })

  it('rereads the trace header and daemon for warm invocations', () => {
    addMetadata(metadata)
    process.env._X_AMZN_TRACE_ID = 'Root=second;Parent=next;Sampled=1'
    process.env.AWS_XRAY_DAEMON_ADDRESS = '127.0.0.2:2001'
    addLambdaTriggerTags({ source: 'second' })
    const [message, , , port, address] = socket.send.secondCall.args
    assert.strictEqual(JSON.parse(message.toString().split('\n')[1]).trace_id, 'second')
    assert.strictEqual(port, 2001)
    assert.strictEqual(address, '127.0.0.2')
    assert.strictEqual(socket.close.callCount, 2)
  })

  it('contains serialization and random-source failures before opening a socket', () => {
    const cycle = {}; cycle.self = cycle
    addMetadata(cycle)
    assert.strictEqual(createSocket.callCount, 0)
    randomBytes.throws(Error('random source failure'))
    addMetadata(metadata)
    assert.strictEqual(createSocket.callCount, 0)
  })

  for (const error of [Error('socket failure'), 'non-Error failure']) {
    it(`contains a socket creation failure: ${error}`, () => {
      createSocket.throws(() => { throw error })
      addMetadata(metadata)
      assert.strictEqual(socket.send.callCount, 0)
    })
  }

  it('closes exactly once on a synchronous send failure', () => {
    socket.send.throws(Error('invalid destination'))
    addMetadata(metadata)
    assert.strictEqual(socket.close.callCount, 1)
    assert.strictEqual(socket.listenerCount('error'), 0)
  })

  it('closes exactly once on a failed send callback', () => {
    socket.send.callsFake((message, start, length, port, address, callback) => callback(Error('send failed')))
    addMetadata(metadata)
    assert.strictEqual(socket.close.callCount, 1)
    assert.strictEqual(socket.listenerCount('error'), 0)
  })

  it('handles an asynchronous socket error and a later send callback without double-closing', () => {
    socket.send.callsFake(() => {})
    addMetadata(metadata)
    assert.strictEqual(socket.close.callCount, 0)
    socket.emit('error', Error('bind failed'))
    socket.send.firstCall.args[5](Error('send failed'))
    assert.strictEqual(socket.close.callCount, 1)
    assert.strictEqual(socket.listenerCount('error'), 0)
  })

  it('contains a close failure without retrying the close', () => {
    socket.close.throws(Error('already closed'))
    addMetadata(metadata)
    assert.strictEqual(socket.close.callCount, 1)
  })
})

// Exercise the actual UDP boundary in addition to the deterministic socket cases above.
describe('Lambda X-Ray UDP transport', () => {
  it('delivers the source frame to a local daemon', async () => {
    const oldEnv = process.env
    const daemon = dgram.createSocket('udp4')
    try {
      const listening = once(daemon, 'listening')
      daemon.bind(0, '127.0.0.1')
      await listening
      process.env = {
        ...oldEnv,
        _X_AMZN_TRACE_ID: header,
        AWS_XRAY_DAEMON_ADDRESS: `127.0.0.1:${daemon.address().port}`,
      }
      const received = once(daemon, 'message')
      addMetadata(metadata)
      const [message] = await received
      const [frame, json] = message.toString().split('\n')
      assert.strictEqual(frame, '{"format": "json", "version": 1}')
      const segment = JSON.parse(json)
      assert.strictEqual(segment.trace_id, traceId)
      assert.strictEqual(segment.parent_id, parentId)
      assert.match(segment.id, /^[0-9a-f]{16}$/)
      assert.deepStrictEqual(segment.metadata, { datadog: { trace: metadata } })
    } finally {
      process.env = oldEnv
      daemon.close()
    }
  })
})
