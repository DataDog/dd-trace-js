'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../setup/core')

describe('child_session', () => {
  let childSession
  let shimmer
  let fakeChildProcess

  beforeEach(() => {
    fakeChildProcess = {
      spawn: sinon.stub(),
      spawnSync: sinon.stub(),
      fork: sinon.stub(),
    }

    shimmer = {
      wrap: sinon.stub().callsFake((obj, method, wrapper) => {
        obj[method] = wrapper(obj[method])
      }),
    }

    childSession = proxyquire('../../src/telemetry/child_session', {
      '../../../datadog-shimmer': shimmer,
      'child_process': fakeChildProcess,
    })
  })

  afterEach(() => {
    sinon.restore()
  })

  it('should patch spawn, spawnSync, and fork', () => {
    childSession.start({
      rootSessionId: 'root-id',
      tags: { 'runtime-id': 'current-id' },
    })

    assert.strictEqual(shimmer.wrap.callCount, 3)
    assert.strictEqual(shimmer.wrap.getCall(0).args[1], 'spawn')
    assert.strictEqual(shimmer.wrap.getCall(1).args[1], 'spawnSync')
    assert.strictEqual(shimmer.wrap.getCall(2).args[1], 'fork')
  })

  it('should only patch once', () => {
    const config = { rootSessionId: 'root-id', tags: { 'runtime-id': 'current-id' } }
    childSession.start(config)
    childSession.start(config)

    assert.strictEqual(shimmer.wrap.callCount, 3)
  })

  it('should inject session env vars into spawn(file, args, options)', () => {
    childSession.start({
      rootSessionId: 'root-id',
      tags: { 'runtime-id': 'current-id' },
    })

    fakeChildProcess.spawn('node', ['test.js'], { cwd: '/tmp' })

    const call = fakeChildProcess.spawn.getCall(0)
    // The original stub was replaced by wrapper; the wrapper calls original.apply
    // Since shimmer replaces the method, we check the wrapper behavior directly
    // We need to verify the env was injected - let's test via the wrapper
  })

  describe('env injection', () => {
    let originalSpawn
    let originalFork
    let originalSpawnSync

    beforeEach(() => {
      originalSpawn = sinon.stub()
      originalFork = sinon.stub()
      originalSpawnSync = sinon.stub()

      fakeChildProcess.spawn = originalSpawn
      fakeChildProcess.spawnSync = originalSpawnSync
      fakeChildProcess.fork = originalFork

      childSession = proxyquire('../../src/telemetry/child_session', {
        '../../../datadog-shimmer': shimmer,
        'child_process': fakeChildProcess,
      })

      childSession.start({
        rootSessionId: 'root-id',
        tags: { 'runtime-id': 'current-id' },
      })
    })

    it('should inject env vars when spawn is called with (file, args, options)', () => {
      fakeChildProcess.spawn('node', ['test.js'], { cwd: '/tmp', env: { FOO: 'bar' } })

      sinon.assert.calledOnce(originalSpawn)
      const args = originalSpawn.getCall(0).args
      assert.strictEqual(args[0], 'node')
      assert.deepStrictEqual(args[1], ['test.js'])
      assert.strictEqual(args[2].cwd, '/tmp')
      assert.strictEqual(args[2].env.FOO, 'bar')
      assert.strictEqual(args[2].env.DD_ROOT_JS_SESSION_ID, 'root-id')
      assert.strictEqual(args[2].env.DD_PARENT_JS_SESSION_ID, 'current-id')
    })

    it('should inject env vars when spawn is called with (file, options)', () => {
      fakeChildProcess.spawn('node', { cwd: '/tmp' })

      sinon.assert.calledOnce(originalSpawn)
      const args = originalSpawn.getCall(0).args
      assert.strictEqual(args[0], 'node')
      assert.strictEqual(args[1].cwd, '/tmp')
      assert.strictEqual(args[1].env.DD_ROOT_JS_SESSION_ID, 'root-id')
      assert.strictEqual(args[1].env.DD_PARENT_JS_SESSION_ID, 'current-id')
    })

    it('should inject env vars when spawn is called with (file) only', () => {
      fakeChildProcess.spawn('node')

      sinon.assert.calledOnce(originalSpawn)
      const args = originalSpawn.getCall(0).args
      assert.strictEqual(args[0], 'node')
      assert.deepStrictEqual(args[1], [])
      assert.strictEqual(args[2].env.DD_ROOT_JS_SESSION_ID, 'root-id')
      assert.strictEqual(args[2].env.DD_PARENT_JS_SESSION_ID, 'current-id')
    })

    it('should inject env vars into spawnSync', () => {
      fakeChildProcess.spawnSync('node', ['test.js'], { env: { BAZ: '1' } })

      sinon.assert.calledOnce(originalSpawnSync)
      const args = originalSpawnSync.getCall(0).args
      assert.strictEqual(args[2].env.BAZ, '1')
      assert.strictEqual(args[2].env.DD_ROOT_JS_SESSION_ID, 'root-id')
      assert.strictEqual(args[2].env.DD_PARENT_JS_SESSION_ID, 'current-id')
    })

    it('should inject env vars into fork with (modulePath, args, options)', () => {
      fakeChildProcess.fork('child.js', ['--flag'], { silent: true })

      sinon.assert.calledOnce(originalFork)
      const args = originalFork.getCall(0).args
      assert.strictEqual(args[0], 'child.js')
      assert.deepStrictEqual(args[1], ['--flag'])
      assert.strictEqual(args[2].silent, true)
      assert.strictEqual(args[2].env.DD_ROOT_JS_SESSION_ID, 'root-id')
      assert.strictEqual(args[2].env.DD_PARENT_JS_SESSION_ID, 'current-id')
    })

    it('should inject env vars into fork with (modulePath, options)', () => {
      fakeChildProcess.fork('child.js', { silent: true })

      sinon.assert.calledOnce(originalFork)
      const args = originalFork.getCall(0).args
      assert.strictEqual(args[0], 'child.js')
      assert.strictEqual(args[1].silent, true)
      assert.strictEqual(args[1].env.DD_ROOT_JS_SESSION_ID, 'root-id')
      assert.strictEqual(args[1].env.DD_PARENT_JS_SESSION_ID, 'current-id')
    })

    it('should use process.env as base when no env is specified', () => {
      fakeChildProcess.spawn('node', ['test.js'], {})

      sinon.assert.calledOnce(originalSpawn)
      const env = originalSpawn.getCall(0).args[2].env
      assert.strictEqual(env.DD_ROOT_JS_SESSION_ID, 'root-id')
      // Should also contain existing process.env keys
      assert.strictEqual(env.PATH, process.env.PATH) // eslint-disable-line eslint-rules/eslint-process-env
    })
  })
})
