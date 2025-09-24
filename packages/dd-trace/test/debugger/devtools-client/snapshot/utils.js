'use strict'

const assert = require('node:assert')
const { join, basename } = require('node:path')

const session = require('./stub-session')
const proxyquire = require('proxyquire')

const collectorWithStub = proxyquire('../../../../src/debugger/devtools-client/snapshot/collector', {
  '../session': session
})
const redactionWithStub = proxyquire.noCallThru()('../../../../src/debugger/devtools-client/snapshot/redaction', {
  '../config': {
    dynamicInstrumentation: {
      redactedIdentifiers: [],
      redactionExcludedIdentifiers: []
    },
  }
})

const processorWithStub = proxyquire('../../../../src/debugger/devtools-client/snapshot/processor', {
  './redaction': redactionWithStub
})

const { getLocalStateForCallFrame } = proxyquire('../../../../src/debugger/devtools-client/snapshot', {
  './collector': collectorWithStub,
  './processor': processorWithStub
})

module.exports = {
  session,
  getTargetCodePath,
  enable,
  teardown,
  setAndTriggerBreakpoint,
  assertOnBreakpoint,
  getLocalStateForCallFrame
}

/**
 * @param {string} caller - The filename of the calling spec file (hint: `__filename`)
 */
function getTargetCodePath (caller) {
  // Convert /path/to/file.spec.js to /path/to/target-code/file.js
  const filename = basename(caller)
  return caller.replace(filename, join('target-code', filename.replace('.spec', '')))
}

/**
 * @param {string} caller - The filename of the calling spec file (hint: `__filename`)
 */
function enable (caller) {
  const path = getTargetCodePath(caller)

  // The beforeEach hook
  return async () => {
    // The scriptIds are resolved asynchronously, so to ensure we have an easy way to get them for each script, we
    // store a promise on the script that will resolve to its id once it's emitted by Debugger.scriptParsed.
    let pResolve = null
    const p = new Promise((resolve) => {
      pResolve = resolve
    })
    p.resolve = pResolve
    require(path).scriptId = p

    session.on('Debugger.scriptParsed', ({ params }) => {
      if (params.url.endsWith(path)) {
        require(path).scriptId.resolve(params.scriptId)
      }
    })

    await session.post('Debugger.enable')
  }
}

async function teardown () {
  session.removeAllListeners('Debugger.scriptParsed')
  session.removeAllListeners('Debugger.paused')
  await session.post('Debugger.disable')
}

async function setAndTriggerBreakpoint (path, line) {
  const { run, scriptId } = require(path)
  await session.post('Debugger.setBreakpoint', {
    location: {
      scriptId: await scriptId,
      lineNumber: line - 1 // Beware! lineNumber is zero-indexed
    }
  })
  run()
}

function assertOnBreakpoint (done, snapshotConfig, callback) {
  if (typeof snapshotConfig === 'function') {
    callback = snapshotConfig
    snapshotConfig = undefined
  }

  session.once('Debugger.paused', ({ params }) => {
    assert.strictEqual(params.hitBreakpoints.length, 1)

    getLocalStateForCallFrame(params.callFrames[0], snapshotConfig).then((process) => {
      callback(process())
      done()
    }).catch(done)
  })
}
