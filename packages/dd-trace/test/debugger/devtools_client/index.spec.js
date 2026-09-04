'use strict'

const assert = require('node:assert/strict')
const workerThreads = require('node:worker_threads')

const { beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../setup/mocha')

const { LARGE_OBJECT_SKIP_THRESHOLD } = require('../../../src/debugger/devtools_client/snapshot/constants')
const { EVENT_TYPE, GuardrailMetrics, INCOMPLETE_REASON } = require('../../../src/debugger/guardrail-metrics')
const { installProbeSampler } = require('../../../src/debugger/probe_sampler')
const { MAX_SAMPLED_PROBES_PER_PAUSE } = require('../../../src/debugger/probe_sampler_constants')

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
    callFrames: [{
      callFrameId: 'call-frame-id',
      functionName,
      location: { scriptId, lineNumber: breakpoint.line - 1, columnNumber: 0 },
    }],
  },
}

describe('onPause', function () {
  /**
   * @typedef {{
   *   on: sinon.SinonSpy & { args: Array<[string, Function]> },
   *   post: sinon.SinonSpy,
   *   emit: sinon.SinonSpy,
   *   '@noCallThru'?: boolean
   * }} MockSession
   */
  /** @type {MockSession} */
  let session
  /** @type {sinon.SinonSpy} */
  let send
  /** @type {Function} */
  let onPaused
  /** @type {sinon.SinonSpy} */
  let ackEmitting
  /** @type {import('../../../src/debugger/devtools_client/state')} */
  let state
  /** @type {Int32Array} */
  let sampledProbeIndexes
  /** @type {unknown} */
  let log

  beforeEach(async function () {
    ackEmitting = sinon.spy()
    log = {
      error: sinon.spy(),
      debug: sinon.spy(),
      '@noCallThru': true,
    }

    session = {
      on: sinon.spy((event, listener) => {
        if (event === 'Debugger.scriptParsed') {
          listener({ params: { scriptId, url } })
        }
      }),
      post: sinon.stub().callsFake((method, params) => {
        if (method === 'Debugger.evaluateOnCallFrame') {
          return Promise.resolve({ result: { value: [{}] } })
        }
        return Promise.resolve({})
      }),
      emit: sinon.spy(),
      '@noCallThru': true,
    }

    const config = {
      service: 'my-service',
      runtimeId: 'my-runtime-id',
      parentThreadId,
      dynamicInstrumentation: {
        captureTimeoutNs: 15_000_000n, // Default value is 15ms
        redactedIdentifiers: [],
        redactionExcludedIdentifiers: [],
      },
      propagateProcessTags: { enabled: false },
      '@noCallThru': true,
    }

    send = sinon.spy()
    send['@noCallThru'] = true
    sampledProbeIndexes = new Int32Array(installProbeSampler(new GuardrailMetrics(GuardrailMetrics.createBuffer())))

    state = proxyquire('../../../src/debugger/devtools_client/state', { './session': session })
    const loadStatus = proxyquire.noCallThru()
    loadStatus('../../../src/debugger/devtools_client/status', { './config': config })
    const collector = proxyquire('../../../src/debugger/devtools_client/snapshot/collector', { '../session': session })
    const redaction = proxyquire('../../../src/debugger/devtools_client/snapshot/redaction', { '../config': config })
    const processor = proxyquire('../../../src/debugger/devtools_client/snapshot/processor', {
      './redaction': redaction,
    })
    const snapshot = proxyquire('../../../src/debugger/devtools_client/snapshot', {
      '../session': session,
      './collector': collector,
      './processor': processor,
    })
    proxyquire('../../../src/debugger/devtools_client', {
      worker_threads: {
        ...workerThreads,
        workerData: { probeSamplerBuffer: sampledProbeIndexes.buffer },
      },
      './config': config,
      './session': session,
      './state': state,
      './snapshot': snapshot,
      './log': log,
      './send': send,
      './status': { ackEmitting },
      './remote_config': { '@noCallThru': true },
    })

    const onPausedCall = session.on.args.find(([event]) => event === 'Debugger.paused')
    assert(onPausedCall, 'onPaused call should be found')
    onPaused = onPausedCall[1]
  })

  /**
   * Attach a probe to the hit breakpoint and mark it as sampled for the next pause.
   *
   * @param {ReturnType<typeof genProcessedProbe>} probe - The probe to sample.
   */
  function sampleProbe (probe) {
    state.breakpointToProbes.set(breakpointId, new Map([[probe.id, probe]]))
    state.samplingIndexToProbe.set(1, probe)
    Atomics.store(sampledProbeIndexes, 0, 1)
    Atomics.store(sampledProbeIndexes, 2, 1)
  }

  it('should not fail if there is no probe for at the breakpoint', async function () {
    await onPaused(event)
    sinon.assert.calledOnceWithExactly(session.post, 'Debugger.resume')
    sinon.assert.notCalled(ackEmitting)
    sinon.assert.notCalled(send)
  })

  it('should throw if paused for an unknown reason', async function () {
    const unknownReasonEvent = {
      ...event,
      params: {
        ...event.params,
        reason: 'OOM',
      },
    }

    let thrown
    try {
      await onPaused(unknownReasonEvent)
    } catch (err) {
      thrown = err
    }

    assert(thrown instanceof Error)
    assert.strictEqual(thrown.message, 'Unexpected Debugger.paused reason: OOM')
    sinon.assert.notCalled(session.post)
    sinon.assert.notCalled(ackEmitting)
    sinon.assert.notCalled(send)
  })

  it('should process only sampled probes for a breakpoint', async function () {
    const probe1 = genProcessedProbe('probe-1')
    const probe2 = genProcessedProbe('probe-2')

    state.breakpointToProbes.set(breakpointId, new Map([
      [probe1.id, probe1],
      [probe2.id, probe2],
    ]))
    state.samplingIndexToProbe.set(1, probe2)
    Atomics.store(sampledProbeIndexes, 0, 1)
    Atomics.store(sampledProbeIndexes, 2, 1)

    await onPaused(event)

    sinon.assert.calledWith(session.post.secondCall, 'Debugger.resume')
    sinon.assert.calledOnceWithExactly(ackEmitting, probe2)
    sinon.assert.calledOnce(send)
    assert.strictEqual(send.firstCall.args[0], 'probe 2')
    assert.strictEqual(send.firstCall.args[2], undefined)
  })

  it('should send log probe results as log events', async function () {
    const probe = genProcessedProbe('probe-1')
    sampleProbe(probe)

    await onPaused(event)

    sinon.assert.calledOnce(send)
    const [, , , , , eventType, incompleteReasons] = send.firstCall.args
    assert.strictEqual(eventType, EVENT_TYPE.LOG)
    assert.strictEqual(incompleteReasons, 0)
  })

  it('should send snapshot probe results as snapshot events with the enforced capture limits', async function () {
    const probe = genProcessedProbe('probe-1')
    probe.captureSnapshot = true
    probe.capture = { maxReferenceDepth: 0, maxCollectionSize: 100, maxFieldCount: 20, maxLength: 255 }
    sampleProbe(probe)

    session.post = sinon.stub().callsFake((method, params) => {
      if (method === 'Debugger.evaluateOnCallFrame') return Promise.resolve({ result: { value: [{}] } })
      if (method === 'Runtime.getProperties' && params.objectId === 'scope-object-id') {
        return Promise.resolve({
          result: [{ name: 'obj', value: { type: 'object', className: 'Object', objectId: 'nested-object-id' } }],
        })
      }
      return Promise.resolve({})
    })
    const eventWithScope = {
      params: {
        ...event.params,
        callFrames: [{
          ...event.params.callFrames[0],
          scopeChain: [{ type: 'local', object: { objectId: 'scope-object-id' } }],
        }],
      },
    }

    await onPaused(eventWithScope)

    sinon.assert.calledOnce(send)
    const [, , , snapshot, , eventType, incompleteReasons] = send.firstCall.args
    assert.deepStrictEqual(snapshot.captures, {
      lines: { 1: { locals: { obj: { type: 'Object', notCapturedReason: 'depth' } } } },
    })
    assert.strictEqual(eventType, EVENT_TYPE.SNAPSHOT)
    assert.strictEqual(incompleteReasons, INCOMPLETE_REASON.DEPTH)
  })

  it('should record a runtime error when the snapshot cannot be collected', async function () {
    const probe = genProcessedProbe('probe-1')
    probe.captureSnapshot = true
    probe.capture = { maxReferenceDepth: 3, maxCollectionSize: 100, maxFieldCount: 20, maxLength: 255 }
    sampleProbe(probe)

    session.post = sinon.stub().callsFake((method) => {
      if (method === 'Debugger.evaluateOnCallFrame') return Promise.resolve({ result: { value: [{}] } })
      if (method === 'Runtime.getProperties') return Promise.reject(new Error('boom'))
      return Promise.resolve({})
    })
    const eventWithScope = {
      params: {
        ...event.params,
        callFrames: [{
          ...event.params.callFrames[0],
          scopeChain: [{ type: 'local', object: { objectId: 'scope-object-id' } }],
        }],
      },
    }

    await onPaused(eventWithScope)

    sinon.assert.calledOnce(send)
    const [, , , snapshot, , eventType, incompleteReasons] = send.firstCall.args
    assert.strictEqual(snapshot.evaluationErrors.length, 1)
    assert.strictEqual(eventType, EVENT_TYPE.SNAPSHOT)
    assert.strictEqual(incompleteReasons, INCOMPLETE_REASON.RUNTIME_ERROR)
    assert.strictEqual(probe.captureSnapshot, false, 'should disable future snapshots for the probe')
  })

  it('should not record a runtime error when the large object safety threshold disables the snapshot',
    async function () {
      const probe = genProcessedProbe('probe-1')
      probe.captureSnapshot = true
      probe.capture = { maxReferenceDepth: 3, maxCollectionSize: 100, maxFieldCount: 20, maxLength: 255 }
      sampleProbe(probe)

      const hugeObjectProperties = Array.from({ length: LARGE_OBJECT_SKIP_THRESHOLD + 1 }, (_, i) => ({
        name: `property${i}`, value: { type: 'number', value: i }, enumerable: true,
      }))
      session.post = sinon.stub().callsFake((method, params) => {
        if (method === 'Debugger.evaluateOnCallFrame') return Promise.resolve({ result: { value: [{}] } })
        if (method === 'Runtime.getProperties') {
          return Promise.resolve(params.objectId === 'scope-object-id'
            ? {
                result: [{
                  name: 'huge',
                  value: { type: 'object', className: 'Object', description: 'Object', objectId: 'huge-object-id' },
                  enumerable: true,
                }],
              }
            : { result: hugeObjectProperties })
        }
        return Promise.resolve({})
      })
      const eventWithScope = {
        params: {
          ...event.params,
          callFrames: [{
            ...event.params.callFrames[0],
            scopeChain: [{ type: 'local', object: { objectId: 'scope-object-id' } }],
          }],
        },
      }

      await onPaused(eventWithScope)

      sinon.assert.calledOnce(send)
      const [, , , snapshot, , eventType, incompleteReasons] = send.firstCall.args
      assert.strictEqual(snapshot.captures.lines[1].locals.huge.notCapturedReason, 'fieldCount')
      assert.strictEqual(snapshot.evaluationErrors.length, 1, 'should tell the user why future captures are skipped')
      assert.strictEqual(eventType, EVENT_TYPE.SNAPSHOT)
      assert.strictEqual(incompleteReasons, INCOMPLETE_REASON.FIELD_COUNT, 'should not count it as a runtime error')
      assert.strictEqual(probe.captureSnapshot, false, 'should disable future snapshots for the probe')
    })

  it('should send capture expression results as snapshot events', async function () {
    const probe = genProcessedProbe('probe-1')
    probe.compiledCaptureExpressions = [{
      name: 'foo',
      expression: 'foo',
      limits: { maxReferenceDepth: 3, maxCollectionSize: 100, maxFieldCount: 20, maxLength: 255 },
    }]
    sampleProbe(probe)

    session.post = sinon.stub().callsFake((method, params) => {
      if (method === 'Debugger.evaluateOnCallFrame') {
        return params.expression === 'foo'
          ? Promise.resolve({ result: { type: 'string', value: 'x'.repeat(300) } })
          : Promise.resolve({ result: { value: [{}] } })
      }
      return Promise.resolve({})
    })

    await onPaused(event)

    sinon.assert.calledOnce(send)
    const [, , , snapshot, , eventType, incompleteReasons] = send.firstCall.args
    assert.deepStrictEqual(snapshot.captures.lines[1].captureExpressions.foo, {
      type: 'string', value: 'x'.repeat(255), truncated: true, size: 300,
    })
    assert.strictEqual(eventType, EVENT_TYPE.SNAPSHOT)
    assert.strictEqual(incompleteReasons, INCOMPLETE_REASON.STRING_LENGTH)
  })

  it('should record a runtime error when a capture expression fails to evaluate', async function () {
    const probe = genProcessedProbe('probe-1')
    probe.compiledCaptureExpressions = [{
      name: 'foo',
      expression: 'foo',
      limits: { maxReferenceDepth: 3, maxCollectionSize: 100, maxFieldCount: 20, maxLength: 255 },
    }]
    sampleProbe(probe)

    session.post = sinon.stub().callsFake((method, params) => {
      if (method === 'Debugger.evaluateOnCallFrame') {
        return params.expression === 'foo'
          ? Promise.resolve({
            result: { type: 'object', subtype: 'error' },
            exceptionDetails: { exception: { description: 'ReferenceError: foo is not defined' } },
          })
          : Promise.resolve({ result: { value: [{}] } })
      }
      return Promise.resolve({})
    })

    await onPaused(event)

    sinon.assert.calledOnce(send)
    const [, , , snapshot, , eventType, incompleteReasons] = send.firstCall.args
    assert.deepStrictEqual(snapshot.evaluationErrors, [{ expr: 'foo', message: 'ReferenceError: foo is not defined' }])
    assert.strictEqual(eventType, EVENT_TYPE.SNAPSHOT)
    assert.strictEqual(incompleteReasons, INCOMPLETE_REASON.RUNTIME_ERROR)
  })

  it('should log sampler overflow', async function () {
    state.breakpointToProbes.set(breakpointId, new Map())
    Atomics.store(sampledProbeIndexes, 1, 1)

    await onPaused(event)

    sinon.assert.calledWith(log.error,
      '[debugger:devtools_client] Too many probes sampled at the same breakpoint location; skipping excess probes')
    sinon.assert.calledOnceWithExactly(session.post, 'Debugger.resume')
    sinon.assert.notCalled(ackEmitting)
    sinon.assert.notCalled(send)
  })

  it('should not read past the sampled probe buffer when more probes are sampled than it can hold', async function () {
    const probesAtLocation = new Map()
    const sampler = getSampler()
    for (let i = 0; i <= MAX_SAMPLED_PROBES_PER_PAUSE; i++) {
      const probe = genProcessedProbe(`probe-${i}`)
      probesAtLocation.set(probe.id, probe)
      state.samplingIndexToProbe.set(i, probe)
      sampler.makeSampleDecision(i, probe.id, 0n, false)
    }
    state.breakpointToProbes.set(breakpointId, probesAtLocation)

    await onPaused(event)

    sinon.assert.calledWith(log.error,
      '[debugger:devtools_client] Too many probes sampled at the same breakpoint location; skipping excess probes')
    sinon.assert.calledWith(session.post.secondCall, 'Debugger.resume')
    sinon.assert.callCount(ackEmitting, MAX_SAMPLED_PROBES_PER_PAUSE)
    sinon.assert.callCount(send, MAX_SAMPLED_PROBES_PER_PAUSE)
  })

  it('should log if a sampled probe index is unknown', async function () {
    state.breakpointToProbes.set(breakpointId, new Map())
    Atomics.store(sampledProbeIndexes, 0, 1)
    Atomics.store(sampledProbeIndexes, 2, 42)

    await onPaused(event)

    sinon.assert.calledWith(log.error, '[debugger:devtools_client] No probe found for sampled probe index %d', 42)
    sinon.assert.calledOnceWithExactly(session.post, 'Debugger.resume')
    sinon.assert.notCalled(ackEmitting)
    sinon.assert.notCalled(send)
  })

  it('should log if a sampled probe is not attached to the hit breakpoint', async function () {
    const probe = genProcessedProbe('probe-1')

    state.breakpointToProbes.set(breakpointId, new Map())
    state.samplingIndexToProbe.set(1, probe)
    Atomics.store(sampledProbeIndexes, 0, 1)
    Atomics.store(sampledProbeIndexes, 2, 1)

    await onPaused(event)

    sinon.assert.calledWith(log.error,
      '[debugger:devtools_client] Sampled probe %s was not found at breakpoint %s', 'probe-1', breakpointId)
    sinon.assert.calledOnceWithExactly(session.post, 'Debugger.resume')
    sinon.assert.notCalled(ackEmitting)
    sinon.assert.notCalled(send)
  })
})

/**
 * Generate a processed probe fixture for pause-handler tests.
 *
 * @param {string} id - The probe id.
 */
function genProcessedProbe (id) {
  return {
    id,
    version: 1,
    location: { file: path, lines: ['1'] },
    templateRequiresEvaluation: false,
    template: id.replace('-', ' '),
    captureSnapshot: false,
  }
}

/**
 * Get the installed runtime probe sampler for tests.
 */
function getSampler () {
  return /** @type {{ makeSampleDecision: Function }} */ (
    globalThis[Symbol.for('dd-trace')][Symbol.for('dd-trace.debugger.probeSampler')]
  )
}
