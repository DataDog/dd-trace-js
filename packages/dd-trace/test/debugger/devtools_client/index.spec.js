'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')

require('../../setup/mocha')

const proxyquire = require('proxyquire')

const breakpoint = { file: 'file.js', line: 1 }
const breakpointId = 'breakpoint-id'
const scriptId = 'script-id'
const path = `/path/to/${breakpoint.file}`
const url = `file://${path}`
const functionName = 'myFn'
const parentThreadId = 'my-parent-thread-id'
const event = {
  params: {
    hitBreakpoints: [breakpointId],
    callFrames: [{ functionName, location: { scriptId, lineNumber: breakpoint.line - 1, columnNumber: 0 } }]
  }
}

describe('onPause', function () {
  let session, send, onPaused, ackReceived

  beforeEach(async function () {
    ackReceived = sinon.spy()

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
})
