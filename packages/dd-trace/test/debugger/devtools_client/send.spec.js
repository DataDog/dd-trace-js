'use strict'

const assert = require('node:assert/strict')
const { hostname: getHostname } = require('node:os')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const JSONBuffer = require('../../../src/debugger/devtools_client/json-buffer')
const { version } = require('../../../../../package.json')
const { getRequestOptions } = require('./utils')

require('../../setup/mocha')

process.env.DD_ENV = 'my-env'
process.env.DD_VERSION = 'my-version'
const service = 'my-service'
const commitSHA = 'my-commit-sha'
const repositoryUrl = 'my-repository-url'
const url = 'my-url'
const ddsource = 'dd_debugger'
const hostname = getHostname()
const message = { message: true }
const logger = { logger: true }
const dd = { dd: true }
const snapshot = { snapshot: true }

describe('input message http requests', function () {
  /** @type {sinon.SinonFakeTimers} */
  let clock
  /** @type {typeof import('../../../src/debugger/devtools_client/send')} */
  let send
  /** @type {sinon.SinonSpy} */
  let request
  /** @type {sinon.SinonSpy} */
  let jsonBufferWrite
  /** @type {sinon.SinonStub} */
  let pruneSnapshotStub

  beforeEach(function () {
    clock = sinon.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    })

    request = sinon.spy()
    request['@noCallThru'] = true

    pruneSnapshotStub = sinon.stub()
    pruneSnapshotStub['@noCallThru'] = true

    class JSONBufferSpy extends JSONBuffer {
      constructor (...args) {
        super(...args)
        jsonBufferWrite = sinon.spy(this, 'write')
      }
    }

    send = proxyquire('../../../src/debugger/devtools_client/send', {
      './config': createConfigMock(),
      './json-buffer': JSONBufferSpy,
      '../../exporters/common/request': request,
      './snapshot-pruner': { pruneSnapshot: pruneSnapshotStub },
    })
  })

  afterEach(function () {
    clock.restore()
  })

  it('should buffer instead of calling request directly', function () {
    send(message, logger, dd, snapshot)
    sinon.assert.notCalled(request)
    sinon.assert.calledOnceWithMatch(jsonBufferWrite, JSON.stringify(getPayload()))
  })

  it('should call request with the expected payload once the buffer is flushed', function (done) {
    send({ message: 1 }, logger, dd, snapshot)
    send({ message: 2 }, logger, dd, snapshot)
    send({ message: 3 }, logger, dd, snapshot)
    sinon.assert.notCalled(request)

    clock.tick(1000)

    sinon.assert.calledOnceWithMatch(request, JSON.stringify([
      getPayload({ message: 1 }),
      getPayload({ message: 2 }),
      getPayload({ message: 3 }),
    ]))

    const opts = getRequestOptions(request)
    assert.strictEqual(opts.method, 'POST')
    assert.strictEqual(opts.path,
      '/debugger/v2/input?ddtags=' +
        `env%3A${process.env.DD_ENV}%2C` +
        `version%3A${process.env.DD_VERSION}%2C` +
        `debugger_version%3A${version}%2C` +
        `host_name%3A${hostname}%2C` +
        `git.commit.sha%3A${commitSHA}%2C` +
        `git.repository_url%3A${repositoryUrl}`)

    done()
  })

  it('should use /debugger/v2/input when configured', function (done) {
    // Create a new send module with v2 endpoint configured
    const sendV2 = proxyquire('../../../src/debugger/devtools_client/send', {
      './config': createConfigMock({ inputPath: '/debugger/v2/input' }),
      './json-buffer': JSONBuffer,
      '../../exporters/common/request': request,
      './snapshot-pruner': { pruneSnapshot: pruneSnapshotStub },
    })

    sendV2(message, logger, dd, snapshot)
    clock.tick(1000)

    sinon.assert.calledOnce(request)
    const opts = getRequestOptions(request)
    assert.strictEqual(opts.method, 'POST')
    assert.ok(
      opts.path.startsWith('/debugger/v2/input?ddtags='),
      `Expected path to start with /debugger/v2/input?ddtags= but got ${opts.path}`
    )

    done()
  })

  it('should fallback to /debugger/v1/diagnostics on 404 from v2 endpoint', function (done) {
    const configStub = createConfigMock({ inputPath: '/debugger/v2/input' })

    // Mock request to return 404 on first call (v2), then succeed on second call (diagnostics)
    let callCount = 0
    const requestWith404 = sinon.spy((payload, opts, callback) => {
      if (++callCount === 1) {
        // First call to v2 - return 404
        callback(new Error('404'), null, 404)
      } else {
        // Second call to diagnostics - succeed
        callback(null)
      }
    })
    requestWith404['@noCallThru'] = true

    const sendV2 = proxyquire('../../../src/debugger/devtools_client/send', {
      './config': configStub,
      './json-buffer': JSONBuffer,
      '../../exporters/common/request': requestWith404,
      './snapshot-pruner': { pruneSnapshot: pruneSnapshotStub },
    })

    sendV2(message, logger, dd, snapshot)
    clock.tick(1000)

    // Should have been called twice: once with v2 (404), once with diagnostics (success)
    sinon.assert.calledTwice(requestWith404)

    const firstCallOpts = requestWith404.getCall(0).args[1]
    assert.ok(firstCallOpts.path.startsWith('/debugger/v2/input?ddtags='),
      `First call should use v2 endpoint but got ${firstCallOpts.path}`)

    const secondCallOpts = requestWith404.getCall(1).args[1]
    assert.ok(secondCallOpts.path.startsWith('/debugger/v1/diagnostics?ddtags='),
      `Second call should fallback to diagnostics endpoint but got ${secondCallOpts.path}`)

    // Verify config was updated to diagnostics
    assert.strictEqual(configStub.inputPath, '/debugger/v1/diagnostics')

    done()
  })

  it('should stick with diagnostics endpoint after fallback', function (done) {
    const configStub = createConfigMock({ inputPath: '/debugger/v2/input' })

    // Mock request to return 404 on first flush, then succeed on subsequent calls
    let callCount = 0
    const requestWith404 = sinon.spy((payload, opts, callback) => {
      if (++callCount === 1) {
        // First call to v2 - return 404
        callback(new Error('404'), null, 404)
      } else {
        // All subsequent calls succeed
        callback(null)
      }
    })
    requestWith404['@noCallThru'] = true

    const sendV2 = proxyquire('../../../src/debugger/devtools_client/send', {
      './config': configStub,
      './json-buffer': JSONBuffer,
      '../../exporters/common/request': requestWith404,
      './snapshot-pruner': { pruneSnapshot: pruneSnapshotStub },
    })

    // First send - should trigger v2 → diagnostics fallback
    sendV2({ message: 1 }, logger, dd, snapshot)
    clock.tick(1000)

    // Second send - should use diagnostics directly (no fallback)
    sendV2({ message: 2 }, logger, dd, snapshot)
    clock.tick(1000)

    // Should have been called 3 times total:
    // 1. First flush with v2 (404)
    // 2. First flush retry with diagnostics (success)
    // 3. Second flush with diagnostics (success)
    sinon.assert.calledThrice(requestWith404)

    const thirdCallOpts = requestWith404.getCall(2).args[1]
    assert.ok(thirdCallOpts.path.startsWith('/debugger/v1/diagnostics?ddtags='),
      `Third call should stick with diagnostics endpoint but got ${thirdCallOpts.path}`)

    done()
  })

  describe('snapshot pruning', function () {
    const largeSnapshot = {
      id: '123',
      stack: [{ function: 'test' }],
      captures: {
        lines: {
          10: {
            locals: {
              largeData: { type: 'string', value: 'x'.repeat(2 * 1024 * 1024) },
            },
          },
        },
      },
    }
    const prunedPayload = {
      ...getPayload(message),
      debugger: {
        snapshot: {
          id: '123',
          stack: [{ function: 'test' }],
          captures: {
            lines: {
              10: {
                locals: {
                  largeData: { pruned: true },
                },
              },
            },
          },
        },
      },
    }

    it('should not attempt to prune if payload is under size limit', function () {
      send(message, logger, dd, snapshot)
      sinon.assert.notCalled(pruneSnapshotStub)
    })

    it('should attempt to prune if payload exceeds 1MB', function () {
      const prunedJson = JSON.stringify(getPayload(message, largeSnapshot))
      pruneSnapshotStub.returns(prunedJson)

      send(message, logger, dd, largeSnapshot)

      sinon.assert.calledOnce(pruneSnapshotStub)
      const call = pruneSnapshotStub.getCall(0)
      assert.strictEqual(typeof call.args[0], 'string') // json
      assert.strictEqual(typeof call.args[1], 'number') // currentSize
      assert.strictEqual(call.args[2], 1024 * 1024) // maxSize
    })

    it('should use pruned snapshot if pruning succeeds', function () {
      const prunedJson = JSON.stringify(prunedPayload)
      pruneSnapshotStub.returns(prunedJson)

      send(message, logger, dd, largeSnapshot)

      sinon.assert.calledOnce(pruneSnapshotStub)
      sinon.assert.calledOnceWithMatch(jsonBufferWrite, prunedJson)
    })

    it('should fall back to deleting captures if pruning fails', function () {
      pruneSnapshotStub.returns(undefined)

      send(message, logger, dd, largeSnapshot)

      sinon.assert.calledOnce(pruneSnapshotStub)

      // Should write fallback payload without captures
      const writtenJson = jsonBufferWrite.getCall(0).args[0]
      const written = JSON.parse(writtenJson)

      assert.deepStrictEqual(written.debugger.snapshot.captures.lines[10], { pruned: true })
    })
  })
})

/**
 * @param {object} [_message] - The message to get the payload for. Defaults to the {@link message} object.
 * @param {object} [_snapshot] - The snapshot to get the payload for. Defaults to the {@link snapshot} object.
 * @returns {object} - The payload.
 */
function getPayload (_message = message, _snapshot = snapshot) {
  return {
    ddsource,
    hostname,
    service,
    message: _message,
    logger,
    dd,
    debugger: { snapshot: _snapshot },
  }
}

/**
 * Creates a config mock with default values and optional overrides
 * @param {object} [overrides] - Config properties to override
 * @returns {object} Config mock object
 */
function createConfigMock (overrides = {}) {
  return {
    service,
    commitSHA,
    repositoryUrl,
    url,
    inputPath: '/debugger/v2/input',
    maxTotalPayloadSize: 5 * 1024 * 1024,
    dynamicInstrumentation: {
      uploadIntervalSeconds: 1,
    },
    ...overrides,
    '@noCallThru': true,
  }
}
