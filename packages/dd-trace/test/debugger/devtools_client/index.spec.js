'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../../setup/mocha')

const breakpoint = { file: 'file.js', line: 1 }
const breakpointId = 'breakpoint-id'
const scriptId = 'script-id'
const path = `/path/to/${breakpoint.file}`
const url = `file://${path}`
const functionName = 'myFn'
const parentThreadId = 'my-parent-thread-id'
const event = {
  params: {
    reason: 'other',
    hitBreakpoints: [breakpointId],
    callFrames: [{ functionName, location: { scriptId, lineNumber: breakpoint.line - 1, columnNumber: 0 } }]
  }
}

describe('onPause', function () {
  let session, send, onPaused, ackReceived, log

  beforeEach(async function () {
    ackReceived = sinon.spy()
    log = {
      error: sinon.spy(),
      debug: sinon.spy(),
      '@noCallThru': true
    }

    session = {
      on: sinon.spy((event, listener) => {
        if (event === 'Debugger.scriptParsed') {
          listener({ params: { scriptId, url } })
        }
      }),
      post: sinon.spy(),
      emit: sinon.spy(),
      '@noCallThru': true
    }

    const config = {
      service: 'my-service',
      runtimeId: 'my-runtime-id',
      parentThreadId,
      dynamicInstrumentation: {
        captureTimeoutNs: 15_000_000n, // Default value is 15ms
        redactedIdentifiers: [],
        redactionExcludedIdentifiers: []
      },
      '@noCallThru': true
    }

    send = sinon.spy()
    send['@noCallThru'] = true

    const state = proxyquire('../../../src/debugger/devtools_client/state', { './session': session })
    proxyquire.noCallThru()('../../../src/debugger/devtools_client/status', { './config': config })
    const collector = proxyquire('../../../src/debugger/devtools_client/snapshot/collector', { '../session': session })
    const redaction = proxyquire('../../../src/debugger/devtools_client/snapshot/redaction', { '../config': config })
    const processor = proxyquire('../../../src/debugger/devtools_client/snapshot/processor', {
      './redaction': redaction
    })
    const snapshot = proxyquire('../../../src/debugger/devtools_client/snapshot', {
      './collector': collector,
      './processor': processor
    })
    proxyquire('../../../src/debugger/devtools_client', {
      './config': config,
      './session': session,
      './state': state,
      './snapshot': snapshot,
      './log': log,
      './send': send,
      './status': { ackReceived },
      './remote_config': { '@noCallThru': true }
    })

    const onPausedCall = session.on.args.find(([event]) => event === 'Debugger.paused')
    onPaused = onPausedCall[1]
  })

  it('should not fail if there is no probe for at the breakpoint', async function () {
    await onPaused(event)
    expect(session.post).to.have.been.calledOnceWith('Debugger.resume')
    expect(ackReceived).to.not.have.been.called
    expect(send).to.not.have.been.called
  })

  it('should throw if paused for an unknown reason', async function () {
    const unknownReasonEvent = {
      ...event,
      params: {
        ...event.params,
        reason: 'OOM'
      }
    }

    let thrown
    try {
      await onPaused(unknownReasonEvent)
    } catch (err) {
      thrown = err
    }

    expect(thrown).to.be.an('error')
    expect(thrown.message).to.equal('Unexpected Debugger.paused reason: OOM')
    expect(session.post).to.not.have.been.called
    expect(ackReceived).to.not.have.been.called
    expect(send).to.not.have.been.called
  })
})
