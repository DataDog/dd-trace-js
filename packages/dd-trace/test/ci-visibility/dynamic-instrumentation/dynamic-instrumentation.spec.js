'use strict'

const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const { EventEmitter } = require('node:events')
const path = require('node:path')
const { setImmediate: setImmediatePromise } = require('node:timers/promises')

const { describe, it, afterEach } = require('mocha')
const proxyquire = require('proxyquire').noCallThru().noPreserveCache()
const sinon = require('sinon')

require('../../../../dd-trace/test/setup/core')

describe('test visibility with dynamic instrumentation', () => {
  // Dynamic Instrumentation - Test Visibility not currently supported for windows
  if (process.platform === 'win32') {
    return
  }
  let childProcess

  afterEach(() => {
    if (childProcess) {
      childProcess.kill()
    }
  })

  it('can grab local variables', (done) => {
    childProcess = fork(path.join(__dirname, 'target-app', 'test-visibility-dynamic-instrumentation-script.js'))

    childProcess.on('message', ({ snapshot, probeId }) => {
      if (!snapshot) return

      const { language, stack, probe, captures } = snapshot
      assert.ok(probeId)
      assert.ok(probe)
      assert.ok(stack)
      assert.strictEqual(language, 'javascript')
      assert.strictEqual(probe.version, 0)

      assert.deepStrictEqual(captures, {
        lines: {
          10: {
            locals: {
              a: { type: 'number', value: '1' },
              b: { type: 'number', value: '2' },
              localVar: { type: 'number', value: '1' },
              users: { type: 'Array' },
            },
          },
        },
      })

      done()
    })
  })

  it('omits empty collection payloads from captured values', (done) => {
    childProcess = fork(path.join(__dirname, 'target-app', 'test-visibility-dynamic-instrumentation-script.js'))

    childProcess.on('message', ({ snapshot }) => {
      if (!snapshot) return

      const users = snapshot.captures.lines[10].locals.users
      assert.strictEqual(users.type, 'Array')
      assert.strictEqual('elements' in users, false)
      assert.doesNotMatch(JSON.stringify(snapshot), /"elements":\[\]/)

      done()
    })
  })

  it('waits for in-flight breakpoint hits', (done) => {
    childProcess = fork(path.join(__dirname, 'target-app', 'test-visibility-dynamic-instrumentation-script.js'))

    const messages = []
    childProcess.on('message', (message) => {
      messages.push(message)

      if (!message.drained) return

      assert.ok(messages[0].snapshot)
      assert.ok(messages.some(({ drained }) => drained))
      done()
    })
  })

  it('does not acknowledge drains before queued breakpoint hits', async () => {
    const breakpointSetChannel = new EventEmitter()
    const breakpointHitChannel = new EventEmitter()
    const breakpointRemoveChannel = new EventEmitter()
    const postedBreakpointHits = []
    let resolveStack
    const session = new EventEmitter()
    session.post = sinon.stub()
    session.post.withArgs('Debugger.enable').resolves()
    session.post.withArgs('Debugger.setBreakpoint').resolves({ breakpointId: 'breakpoint-id' })
    session.post.withArgs('Debugger.resume').resolves()
    breakpointSetChannel.postMessage = sinon.stub()
    breakpointHitChannel.postMessage = (message) => {
      postedBreakpointHits.push(message)
    }
    breakpointRemoveChannel.postMessage = sinon.stub()

    proxyquire('../../../src/ci-visibility/dynamic-instrumentation/worker', {
      worker_threads: {
        workerData: {
          breakpointSetChannel,
          breakpointHitChannel,
          breakpointRemoveChannel,
        },
      },
      crypto: {
        randomUUID: () => 'snapshot-id',
      },
      '../../../debugger/devtools_client/session': session,
      '../../../debugger/devtools_client/source-maps': {
        getGeneratedPosition: sinon.stub(),
      },
      '../../../debugger/devtools_client/snapshot': {
        getLocalStateForCallFrame: () => ({
          processLocalState: () => ({ localVariable: { type: 'number', value: '1' } }),
        }),
      },
      '../../../debugger/devtools_client/snapshot/constants': {
        DEFAULT_MAX_REFERENCE_DEPTH: 1,
        DEFAULT_MAX_COLLECTION_SIZE: 1,
        DEFAULT_MAX_FIELD_COUNT: 1,
        DEFAULT_MAX_LENGTH: 1,
      },
      '../../../debugger/devtools_client/state': {
        findScriptFromPartialPath: () => ({ url: 'file.js', scriptId: 'script-id' }),
        getStackFromCallFrames: () => new Promise(resolve => {
          resolveStack = resolve
        }),
      },
      '../../../log': {
        error: () => {},
        warn: () => {},
      },
    })

    breakpointSetChannel.emit('message', { id: 'probe-id', file: 'file.js', line: 10 })
    await setImmediatePromise()

    breakpointHitChannel.emit('message', { drainRequestId: 'drain-id' })
    session.emit('Debugger.paused', {
      params: {
        hitBreakpoints: ['breakpoint-id'],
        callFrames: [{ callFrameId: 'call-frame-id' }],
      },
    })

    await setImmediatePromise()
    assert.deepStrictEqual(postedBreakpointHits, [])

    resolveStack([{ fileName: 'file.js' }])
    await setImmediatePromise()
    await setImmediatePromise()

    assert.deepStrictEqual(postedBreakpointHits, [
      {
        snapshot: {
          id: 'snapshot-id',
          timestamp: postedBreakpointHits[0].snapshot.timestamp,
          probe: {
            id: 'probe-id',
            version: 0,
            location: {
              file: 'file.js',
              lines: ['10'],
            },
          },
          captures: {
            lines: {
              10: {
                locals: {
                  localVariable: {
                    type: 'number',
                    value: '1',
                  },
                },
              },
            },
          },
          stack: [{ fileName: 'file.js' }],
          language: 'javascript',
        },
      },
      {
        drainRequestId: 'drain-id',
      },
    ])
  })
})
