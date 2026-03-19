'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const dc = require('dc-polyfill')

require('../setup/core')

describe('session-propagation', () => {
  const childProcessChannel = dc.tracingChannel('datadog:child_process:execution')
  let sessionPropagation

  beforeEach(() => {
    // Fresh require to reset the subscribed flag
    delete require.cache[require.resolve('../../src/telemetry/session-propagation')]
    sessionPropagation = require('../../src/telemetry/session-propagation')
  })

  afterEach(() => {
    sinon.restore()
  })

  it('should subscribe to child_process channel', () => {
    sessionPropagation.start({
      telemetry: { enabled: true },
      rootSessionId: 'root-id',
      tags: { 'runtime-id': 'current-id' },
    })

    assert.ok(childProcessChannel.start.hasSubscribers)
  })

  it('should not subscribe when telemetry is disabled', () => {
    const subscribeSpy = sinon.spy(childProcessChannel, 'subscribe')

    sessionPropagation.start({
      telemetry: { enabled: false },
      rootSessionId: 'root-id',
      tags: { 'runtime-id': 'current-id' },
    })

    assert.strictEqual(subscribeSpy.callCount, 0)
  })

  it('should only subscribe once', () => {
    const config = { telemetry: { enabled: true }, rootSessionId: 'root-id', tags: { 'runtime-id': 'current-id' } }
    sessionPropagation.start(config)

    const subscribeSpy = sinon.spy(childProcessChannel, 'subscribe')
    sessionPropagation.start(config)

    assert.strictEqual(subscribeSpy.callCount, 0)
  })

  describe('env injection via callArgs', () => {
    let onChildProcessStart

    beforeEach(() => {
      sessionPropagation.start({
        telemetry: { enabled: true },
        rootSessionId: 'root-id',
        tags: { 'runtime-id': 'current-id' },
      })
      onChildProcessStart = sessionPropagation._onChildProcessStart
    })

    it('should inject env vars when callArgs has (file, args, options)', () => {
      const context = {
        callArgs: ['node', ['test.js'], { cwd: '/tmp', env: { FOO: 'bar' } }],
        shell: false,
      }

      onChildProcessStart(context)

      assert.strictEqual(context.callArgs[0], 'node')
      assert.deepStrictEqual(context.callArgs[1], ['test.js'])
      assert.strictEqual(context.callArgs[2].cwd, '/tmp')
      assert.strictEqual(context.callArgs[2].env.FOO, 'bar')
      assert.strictEqual(context.callArgs[2].env.DD_ROOT_JS_SESSION_ID, 'root-id')
      assert.strictEqual(context.callArgs[2].env.DD_PARENT_JS_SESSION_ID, 'current-id')
    })

    it('should inject env vars when callArgs has (file, options)', () => {
      const context = {
        callArgs: ['node', { cwd: '/tmp' }],
        shell: false,
      }

      onChildProcessStart(context)

      assert.strictEqual(context.callArgs[0], 'node')
      assert.strictEqual(context.callArgs[1].cwd, '/tmp')
      assert.strictEqual(context.callArgs[1].env.DD_ROOT_JS_SESSION_ID, 'root-id')
      assert.strictEqual(context.callArgs[1].env.DD_PARENT_JS_SESSION_ID, 'current-id')
    })

    it('should inject env vars when callArgs has (file) only for non-shell', () => {
      const context = {
        callArgs: ['node'],
        shell: false,
      }

      onChildProcessStart(context)

      assert.strictEqual(context.callArgs[0], 'node')
      assert.deepStrictEqual(context.callArgs[1], [])
      assert.strictEqual(context.callArgs[2].env.DD_ROOT_JS_SESSION_ID, 'root-id')
      assert.strictEqual(context.callArgs[2].env.DD_PARENT_JS_SESSION_ID, 'current-id')
    })

    it('should inject env vars as options for shell commands with no options', () => {
      const context = {
        callArgs: ['ls -la'],
        shell: true,
      }

      onChildProcessStart(context)

      assert.strictEqual(context.callArgs[0], 'ls -la')
      assert.strictEqual(context.callArgs[1].env.DD_ROOT_JS_SESSION_ID, 'root-id')
      assert.strictEqual(context.callArgs[1].env.DD_PARENT_JS_SESSION_ID, 'current-id')
    })

    it('should use process.env as base when no env is specified', () => {
      const context = {
        callArgs: ['node', ['test.js'], {}],
        shell: false,
      }

      onChildProcessStart(context)

      const env = context.callArgs[2].env
      assert.strictEqual(env.DD_ROOT_JS_SESSION_ID, 'root-id')
      assert.ok(Object.keys(env).length > 2, 'env should contain process.env keys')
    })

    it('should preserve callback when callArgs has (file, args, cb)', () => {
      const cb = () => {}
      const context = {
        callArgs: ['node', ['-v'], cb],
        shell: false,
      }

      onChildProcessStart(context)

      assert.strictEqual(context.callArgs[0], 'node')
      assert.deepStrictEqual(context.callArgs[1], ['-v'])
      assert.strictEqual(context.callArgs[2].env.DD_ROOT_JS_SESSION_ID, 'root-id')
      assert.strictEqual(context.callArgs[3], cb)
    })

    it('should preserve callback when callArgs has (file, cb)', () => {
      const cb = () => {}
      const context = {
        callArgs: ['cmd', cb],
        shell: false,
      }

      onChildProcessStart(context)

      assert.strictEqual(context.callArgs[0], 'cmd')
      assert.deepStrictEqual(context.callArgs[1], [])
      assert.strictEqual(context.callArgs[2].env.DD_ROOT_JS_SESSION_ID, 'root-id')
      assert.strictEqual(context.callArgs[3], cb)
    })

    it('should not modify context without callArgs', () => {
      const context = {
        command: 'node test.js',
        file: 'node',
        shell: false,
      }

      onChildProcessStart(context)

      assert.strictEqual(context.callArgs, undefined)
    })
  })
})
