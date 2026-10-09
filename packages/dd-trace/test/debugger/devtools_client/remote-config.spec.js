'use strict'

const assert = require('node:assert/strict')

const { beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../setup/mocha')

describe('remote config failure reasons', () => {
  let probePort, onMessage, ackError, ackInstalled, addBreakpoint, modifyBreakpoint, removeBreakpoint

  beforeEach(() => {
    probePort = { on: sinon.spy(), postMessage: sinon.spy() }
    ackError = sinon.spy()
    ackInstalled = sinon.spy()
    addBreakpoint = sinon.stub().resolves()
    modifyBreakpoint = sinon.stub().resolves()
    removeBreakpoint = sinon.stub().resolves()
    proxyquire('../../../src/debugger/devtools_client/remote_config', {
      'node:worker_threads': { workerData: { probePort }, '@noCallThru': true },
      './breakpoints': {
        addBreakpoint,
        removeBreakpoint,
        modifyBreakpoint,
        '@noCallThru': true,
      },
      './status': {
        ackReceived: sinon.spy(), ackInstalled, ackError, '@noCallThru': true,
      },
      './log': { debug: sinon.spy(), error: sinon.spy(), '@noCallThru': true },
    })
    const messageSubscription = probePort.on.getCalls().find(call => call.args[0] === 'message')
    assert.ok(messageSubscription)
    onMessage = messageSubscription.args[1]
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
    it(`should acknowledge ${reason} with a separate reason`, async () => {
      const probe = {
        id: 'customer-probe',
        version: 1,
        type: 'LOG_PROBE',
        where: { sourceFile: 'customer-file.js', lines: ['1'] },
        ...overrides,
      }
      await onMessage({ action, probe, ackId: 42 })

      sinon.assert.calledOnce(probePort.postMessage)
      const response = probePort.postMessage.firstCall.args[0]
      assert.strictEqual(response.ackId, 42)
      assert.strictEqual(response.reason, reason)
      assert.strictEqual(response.action, action === 'customer-action' ? 'unknown' : action)
      assert.strictEqual(response.phase, undefined)
      assert.ok(response.error instanceof Error)
      assert.match(response.error.message, new RegExp(`^${message}`))
      sinon.assert.calledOnceWithExactly(ackError, sinon.match.instanceOf(Error), probe)
      sinon.assert.notCalled(addBreakpoint)
    })
  }

  it('should forward the classification of installation errors and preserve the original exception', async () => {
    const error = Object.assign(new Error('boom'), { reason: 'probe_installation_failed', phase: 'install' })
    addBreakpoint.rejects(error)
    const probe = { id: 'probe', type: 'LOG_PROBE', where: { sourceFile: 'app.js', lines: ['1'] } }

    await onMessage({ action: 'apply', probe, ackId: 42 })

    sinon.assert.calledOnceWithExactly(probePort.postMessage, {
      ackId: 42, error, reason: 'probe_installation_failed', action: 'apply', phase: 'install',
    })
    sinon.assert.calledOnceWithExactly(ackError, error, probe)
    sinon.assert.notCalled(ackInstalled)
  })

  it('should not classify errors left unclassified by the breakpoints module', async () => {
    const error = new Error('boom')
    removeBreakpoint.rejects(error)
    const probe = { id: 'probe', type: 'LOG_PROBE', where: { sourceFile: 'app.js', lines: ['1'] } }

    await onMessage({ action: 'unapply', probe, ackId: 42 })

    sinon.assert.calledOnceWithExactly(probePort.postMessage, {
      ackId: 42, error, reason: undefined, action: 'unapply', phase: undefined,
    })
    sinon.assert.calledOnceWithExactly(ackError, error, probe)
  })

  it('should preserve failed update metadata across structured cloning', async () => {
    const error = Object.assign(new Error('customer-secret'), {
      reason: 'probe_installation_failed', phase: 'install',
    })
    modifyBreakpoint.rejects(error)
    const probe = { id: 'probe', version: 2, type: 'LOG_PROBE', where: { sourceFile: 'app.js', lines: ['1'] } }

    await onMessage({ action: 'modify', probe, ackId: 42 })

    const response = structuredClone(probePort.postMessage.firstCall.args[0])
    assert.strictEqual(response.error.reason, undefined)
    assert.strictEqual(response.reason, 'probe_installation_failed')
    assert.strictEqual(response.action, 'modify')
    assert.strictEqual(response.phase, 'install')
    assert.strictEqual(response.error.message, 'customer-secret')
    sinon.assert.notCalled(ackInstalled)
  })

  it('should acknowledge recovered removal without reporting a probe installation', async () => {
    const probe = { id: 'probe', type: 'LOG_PROBE', where: { sourceFile: 'app.js', lines: ['1'] } }

    await onMessage({ action: 'unapply', probe, ackId: 42 })

    sinon.assert.calledOnceWithExactly(removeBreakpoint, probe)
    sinon.assert.calledOnceWithExactly(probePort.postMessage, { ackId: 42 })
    sinon.assert.notCalled(ackError)
    sinon.assert.notCalled(ackInstalled)
  })
})
