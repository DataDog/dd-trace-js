'use strict'

const assert = require('node:assert/strict')

const { beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../setup/mocha')

describe('remote config failure reasons', () => {
  let probePort, onMessage, ackError, addBreakpoint

  beforeEach(() => {
    probePort = { on: sinon.spy(), postMessage: sinon.spy() }
    ackError = sinon.spy()
    addBreakpoint = sinon.stub().resolves()
    proxyquire('../../../src/debugger/devtools_client/remote_config', {
      'node:worker_threads': { workerData: { probePort }, '@noCallThru': true },
      './breakpoints': {
        addBreakpoint,
        removeBreakpoint: sinon.stub().resolves(),
        modifyBreakpoint: sinon.stub().resolves(),
        '@noCallThru': true,
      },
      './status': {
        ackReceived: sinon.spy(), ackInstalled: sinon.spy(), ackError, '@noCallThru': true,
      },
      './log': { debug: sinon.spy(), error: sinon.spy(), '@noCallThru': true },
    })
    onMessage = probePort.on.getCalls().find(call => call.args[0] === 'message').args[1]
  })

  for (const { overrides, action = 'apply', reason, message } of [
    {
      overrides: { type: 'CUSTOMER_PROBE' },
      reason: 'unsupported_probe_type',
      message: 'Unsupported probe type:',
    },
    {
      overrides: { where: { typeName: 'customer-file.js', methodName: 'customerMethod' } },
      reason: 'unsupported_insertion_point',
      message: 'Unsupported probe insertion point!',
    },
    {
      overrides: { captureSnapshot: true, captureExpressions: [{}] },
      reason: 'conflicting_capture_options',
      message: 'Cannot set both captureSnapshot and captureExpressions',
    },
    {
      overrides: {},
      action: 'customer-action',
      reason: 'unknown_remote_config_action',
      message: 'Cannot process probe',
    },
  ]) {
    it(`should acknowledge ${reason} with a reason that survives structured cloning`, async () => {
      const probe = {
        id: 'customer-probe',
        version: 1,
        type: 'LOG_PROBE',
        where: { sourceFile: 'customer-file.js', lines: ['1'] },
        ...overrides,
      }
      await onMessage({ action, probe, ackId: 42 })

      sinon.assert.calledOnce(probePort.postMessage)
      const response = structuredClone(probePort.postMessage.firstCall.args[0])
      assert.strictEqual(response.ackId, 42)
      assert.strictEqual(response.reason, reason)
      assert.ok(response.error instanceof Error)
      assert.match(response.error.message, new RegExp(`^${message}`))
      assert.strictEqual(response.error.reason, undefined)
      sinon.assert.calledOnceWithExactly(ackError, sinon.match.instanceOf(Error), probe)
      sinon.assert.notCalled(addBreakpoint)
    })
  }

  it('should not assign a known reason to other installation errors', async () => {
    const error = new Error('customer-secret')
    addBreakpoint.rejects(error)
    const probe = { id: 'probe', type: 'LOG_PROBE', where: { sourceFile: 'app.js', lines: ['1'] } }

    await onMessage({ action: 'apply', probe, ackId: 42 })

    sinon.assert.calledOnceWithExactly(probePort.postMessage, { ackId: 42, error, reason: undefined })
    sinon.assert.calledOnceWithExactly(ackError, error, probe)
  })
})
