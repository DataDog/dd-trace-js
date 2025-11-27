'use strict'

const assert = require('node:assert/strict')
const { hostname: getHostname } = require('node:os')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const { getRequestOptions } = require('./utils')
const JSONBuffer = require('../../../src/debugger/devtools_client/json-buffer')
const { version } = require('../../../../../package.json')

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
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
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
      './config': {
        service,
        commitSHA,
        repositoryUrl,
        url,
        maxTotalPayloadSize: 5 * 1024 * 1024, // 5MB
        dynamicInstrumentation: {
          uploadIntervalSeconds: 1
        },
        '@noCallThru': true
      },
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
      getPayload({ message: 3 })
    ]))

    const opts = getRequestOptions(request)
    assert.strictEqual(opts.method, 'POST')
    assert.strictEqual(opts.path,
      '/debugger/v1/input?ddtags=' +
        `env%3A${process.env.DD_ENV}%2C` +
        `version%3A${process.env.DD_VERSION}%2C` +
        `debugger_version%3A${version}%2C` +
        `host_name%3A${hostname}%2C` +
        `git.commit.sha%3A${commitSHA}%2C` +
        `git.repository_url%3A${repositoryUrl}`)

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
              largeData: { type: 'string', value: 'x'.repeat(2 * 1024 * 1024) }
            }
          }
        }
      }
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
                  largeData: { pruned: true }
                }
              }
            }
          }
        }
      }
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
    debugger: { snapshot: _snapshot }
  }
}
