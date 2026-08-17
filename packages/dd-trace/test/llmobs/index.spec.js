'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const { DD_MAJOR } = require('../../../../version')
const { INCOMPATIBLE_INITIALIZATION } = require('../../src/llmobs/constants/text')
const LLMObsTagger = require('../../src/llmobs/tagger')
const {
  PROPAGATED_TRACE_ID_KEY,
  SAMPLE_RATE,
  SAMPLING_DECISION,
  SESSION_ID,
  TRACE_ID,
} = require('../../src/llmobs/constants/tags')
const { getConfigFresh } = require('../helpers/config')
const { removeDestroyHandler } = require('./util')

const spanFinishCh = channel('dd-trace:span:finish')
const evalMetricAppendCh = channel('llmobs:eval-metric:append')
const flushCh = channel('llmobs:writers:flush')
const injectCh = channel('dd-trace:span:inject')

describe('module', () => {
  let llmobsModule
  let store
  let logger

  let LLMObsSpanWriterSpy
  let LLMObsEvalMetricsWriterSpy
  let fetchAgentInfoStub
  let registerTelemetryFlusher
  let unregisterTelemetryFlusher
  let originalVercel
  let llmobsModuleProxyRequireMeta

  /** @type {import('sinon').SinonStub} */
  let startupLogStub

  function loadLlmobsModule () {
    llmobsModule = proxyquire('../../../dd-trace/src/llmobs', llmobsModuleProxyRequireMeta)
    removeDestroyHandler()
  }

  function loadLlmobsModuleOnVercel () {
    process.env.VERCEL = '1'
    const loadServerless = proxyquire.noPreserveCache()
    llmobsModuleProxyRequireMeta['../serverless'] = loadServerless(
      '../../../dd-trace/src/serverless',
      {}
    )
    proxyquire.preserveCache()
    loadLlmobsModule()
  }

  beforeEach(() => {
    originalVercel = process.env.VERCEL
    store = {}
    logger = { debug: sinon.stub() }

    LLMObsSpanWriterSpy = sinon.stub().returns({
      destroy: sinon.stub(),
      flush: sinon.stub(),
      setAgentless: sinon.stub(),
    })

    LLMObsEvalMetricsWriterSpy = sinon.stub().returns({
      destroy: sinon.stub(),
      append: sinon.stub(),
      flush: sinon.stub(),
      setAgentless: sinon.stub(),
    })

    fetchAgentInfoStub = sinon.stub()
    unregisterTelemetryFlusher = sinon.stub()
    registerTelemetryFlusher = sinon.stub().returns(unregisterTelemetryFlusher)

    llmobsModuleProxyRequireMeta = {
      './writers/spans': LLMObsSpanWriterSpy,
      './writers/evaluations': LLMObsEvalMetricsWriterSpy,
      '../flush': { registerTelemetryFlusher },
      '../log': logger,
      './storage': {
        storage: {
          getStore () {
            return store
          },
        },
      },
      './writers/util': proxyquire('../../../dd-trace/src/llmobs/writers/util', {
        '../../agent/info': {
          fetchAgentInfo: fetchAgentInfoStub,
        },
      }),
    }

    if (DD_MAJOR < 6) {
      startupLogStub = sinon.stub(console, 'error')
    } else {
      startupLogStub = sinon.stub()

      llmobsModuleProxyRequireMeta['../startup-log'] = {
        logGenericError: startupLogStub,
      }
    }

    loadLlmobsModule()
  })

  afterEach(() => {
    if (originalVercel === undefined) delete process.env.VERCEL
    else process.env.VERCEL = originalVercel
    sinon.restore()
    llmobsModule.disable()
  })

  after(() => {
    // get rid of mock stubs for writers
    delete require.cache[require.resolve('../../../dd-trace/src/llmobs')]
  })

  describe('handle llmobs info injection', () => {
    it('injects LLMObs info when there is a parent LLMObs span', () => {
      llmobsModule.enable({ llmobs: { mlApp: 'test', agentlessEnabled: false } })
      store.span = {
        context () {
          return {
            toSpanId () {
              return 'parent-id'
            },
          }
        },
      }

      const carrier = {
        'x-datadog-tags': '',
      }
      injectCh.publish({ carrier })

      assert.strictEqual(carrier['x-datadog-tags'], '_dd.p.llmobs_parent_id=parent-id,_dd.p.llmobs_ml_app=test')
    })

    it('injects the sampling rate and decision from the parent LLMObs span', () => {
      llmobsModule.enable({ llmobs: { mlApp: 'test', agentlessEnabled: false } })
      store.span = {
        context () {
          return {
            toSpanId () {
              return 'parent-id'
            },
          }
        },
      }
      LLMObsTagger.tagMap.set(store.span, {
        [SAMPLE_RATE]: '0.5',
        [SAMPLING_DECISION]: '0',
      })

      const carrier = {
        'x-datadog-tags': '',
      }
      injectCh.publish({ carrier })

      assert.strictEqual(
        carrier['x-datadog-tags'],
        '_dd.p.llmobs_parent_id=parent-id,_dd.p.llmobs_ml_app=test,_dd.p.llmobs_sr=0.5,_dd.p.llmobs_sd=0'
      )
    })

    it('injects the session_id from the parent LLMObs span', () => {
      llmobsModule.enable({ llmobs: { mlApp: 'test', agentlessEnabled: false } })
      store.span = {
        context () {
          return {
            toSpanId () {
              return 'parent-id'
            },
          }
        },
      }
      LLMObsTagger.tagMap.set(store.span, {
        [SESSION_ID]: 'my-session',
      })

      const carrier = {
        'x-datadog-tags': '',
      }
      injectCh.publish({ carrier })

      assert.strictEqual(
        carrier['x-datadog-tags'],
        '_dd.p.llmobs_parent_id=parent-id,_dd.p.llmobs_ml_app=test,_dd.p.llmobs_sid=my-session'
      )
    })

    it('injects the session_id from the trace-level default when the active span carries none', () => {
      llmobsModule.enable({ llmobs: { mlApp: 'test', agentlessEnabled: false } })
      store.span = {
        context () {
          return {
            toSpanId () {
              return 'parent-id'
            },
            _trace: { tags: { '_ml_obs.trace_session_id': 'trace-session' } },
          }
        },
      }

      const carrier = {
        'x-datadog-tags': '',
      }
      injectCh.publish({ carrier })

      assert.strictEqual(
        carrier['x-datadog-tags'],
        '_dd.p.llmobs_parent_id=parent-id,_dd.p.llmobs_ml_app=test,_dd.p.llmobs_sid=trace-session'
      )
    })

    it('converts the local LLMObs trace id to decimal for propagation', () => {
      llmobsModule.enable({ llmobs: { mlApp: 'test', agentlessEnabled: false } })
      store.span = {
        context () {
          return {
            _trace: { tags: {} },
            toSpanId () { return 'parent-id' },
          }
        },
      }
      LLMObsTagger.tagMap.set(store.span, {
        [TRACE_ID]: '6a5f76e7000000001973227978d8110b',
      })

      const carrier = { 'x-datadog-tags': '' }
      injectCh.publish({ carrier })

      assert.strictEqual(
        carrier['x-datadog-tags'],
        // eslint-disable-next-line @stylistic/max-len
        '_dd.p.llmobs_parent_id=parent-id,_dd.p.llmobs_ml_app=test,_dd.p.llmobs_trace_id=141393847380800662846519802803680448779'
      )
    })

    it('forwards an extracted LLMObs trace id without reinterpreting it', () => {
      llmobsModule.enable({ llmobs: { mlApp: 'test', agentlessEnabled: false } })
      const wireTraceId = '12345678901234567890123456789012'
      store.span = {
        context () {
          return {
            _trace: { tags: { [PROPAGATED_TRACE_ID_KEY]: wireTraceId } },
            toSpanId () { return 'parent-id' },
          }
        },
      }

      const carrier = { 'x-datadog-tags': '' }
      injectCh.publish({ carrier })

      assert.strictEqual(
        carrier['x-datadog-tags'],
        `_dd.p.llmobs_parent_id=parent-id,_dd.p.llmobs_ml_app=test,_dd.p.llmobs_trace_id=${wireTraceId}`
      )
    })

    it('does not inject LLMObs parent ID info when there is no parent LLMObs span', () => {
      llmobsModule.enable({ llmobs: { mlApp: 'test', agentlessEnabled: false } })

      const carrier = {
        'x-datadog-tags': '',
      }
      injectCh.publish({ carrier })
      assert.strictEqual(carrier['x-datadog-tags'], '_dd.p.llmobs_ml_app=test')
    })

    it('does not inject LLMOBs info when there is no mlApp configured and no parent LLMObs span', () => {
      llmobsModule.enable({ llmobs: { agentlessEnabled: false } })

      const carrier = {
        'x-datadog-tags': '',
      }
      injectCh.publish({ carrier })
      assert.strictEqual(carrier['x-datadog-tags'], '')
    })

    it('does not produce a literal "undefined" prefix when carrier has no x-datadog-tags', () => {
      llmobsModule.enable({ llmobs: { mlApp: 'test', agentlessEnabled: false } })

      const carrier = {}
      injectCh.publish({ carrier })

      assert.strictEqual(carrier['x-datadog-tags'], '_dd.p.llmobs_ml_app=test')
    })

    it('appends to an existing non-empty x-datadog-tags with a single comma separator', () => {
      llmobsModule.enable({ llmobs: { mlApp: 'test', agentlessEnabled: false } })

      const carrier = {
        'x-datadog-tags': '_dd.p.tid=69fe014200000000,_dd.p.dm=-0',
      }
      injectCh.publish({ carrier })

      assert.strictEqual(
        carrier['x-datadog-tags'],
        '_dd.p.tid=69fe014200000000,_dd.p.dm=-0,_dd.p.llmobs_ml_app=test'
      )
    })

    it('does not duplicate _dd.p.llmobs_ml_app when already present in x-datadog-tags', () => {
      llmobsModule.enable({ llmobs: { mlApp: 'test', agentlessEnabled: false } })

      const carrier = {
        'x-datadog-tags': '_dd.p.tid=69fe014200000000,_dd.p.dm=-0,_dd.p.llmobs_ml_app=test',
      }
      injectCh.publish({ carrier })

      assert.strictEqual(
        carrier['x-datadog-tags'],
        '_dd.p.tid=69fe014200000000,_dd.p.dm=-0,_dd.p.llmobs_ml_app=test'
      )
    })

    it('preserves non-replaced LLMObs keys from upstream carrier', () => {
      llmobsModule.enable({ llmobs: { mlApp: 'test', agentlessEnabled: false } })

      const carrier = {
        'x-datadog-tags': [
          '_dd.p.tid=69fe014200000000',
          '_dd.p.dm=-0',
          '_dd.p.llmobs_sid=retained-session',
        ].join(','),
      }
      injectCh.publish({ carrier })

      assert.strictEqual(
        carrier['x-datadog-tags'],
        [
          '_dd.p.tid=69fe014200000000',
          '_dd.p.dm=-0',
          '_dd.p.llmobs_sid=retained-session',
          '_dd.p.llmobs_ml_app=test',
        ].join(',')
      )
    })

    it('updates existing LLMObs tags in x-datadog-tags without duplicating keys', () => {
      llmobsModule.enable({ llmobs: { mlApp: 'test', agentlessEnabled: false } })
      store.span = {
        context () {
          return {
            toSpanId () {
              return 'new-parent-id'
            },
          }
        },
      }
      LLMObsTagger.tagMap.set(store.span, {
        [SESSION_ID]: 'new-session',
        [SAMPLE_RATE]: '0.8',
        [SAMPLING_DECISION]: '1',
      })

      const carrier = {
        'x-datadog-tags': [
          '_dd.p.tid=69fe014200000000',
          '_dd.p.llmobs_parent_id=old-id',
          '_dd.p.llmobs_ml_app=old-app',
          '_dd.p.llmobs_sid=old-session',
        ].join(','),
      }
      injectCh.publish({ carrier })

      assert.strictEqual(
        carrier['x-datadog-tags'],
        [
          '_dd.p.tid=69fe014200000000',
          '_dd.p.llmobs_parent_id=new-parent-id',
          '_dd.p.llmobs_ml_app=test',
          '_dd.p.llmobs_sid=new-session',
          '_dd.p.llmobs_sr=0.8',
          '_dd.p.llmobs_sd=1',
        ].join(',')
      )
    })

    it('prevents duplicate tags through the full extraction -> standard propagation -> injection path (#9714)', () => {
      llmobsModule.enable({ llmobs: { mlApp: 'downstream-app', agentlessEnabled: false } })

      const TextMapPropagator = require('../../src/opentracing/propagation/text_map')
      const config = getConfigFresh({ llmobs: { mlApp: 'downstream-app', agentlessEnabled: false } })
      const propagator = new TextMapPropagator(config)

      const inboundCarrier = {
        'x-datadog-trace-id': '1234567890',
        'x-datadog-parent-id': '9876543210',
        'x-datadog-tags': [
          '_dd.p.tid=69fe014200000000',
          '_dd.p.dm=-0',
          '_dd.p.llmobs_ml_app=upstream-app',
          '_dd.p.llmobs_sid=upstream-session',
        ].join(','),
      }

      const spanContext = propagator.extract(inboundCarrier)
      assert.ok(spanContext)
      assert.strictEqual(spanContext._trace.tags['_dd.p.llmobs_ml_app'], 'upstream-app')
      assert.strictEqual(spanContext._trace.tags['_dd.p.llmobs_sid'], 'upstream-session')

      const outboundCarrier = {}
      propagator.inject(spanContext, outboundCarrier)

      const tags = outboundCarrier['x-datadog-tags']
      assert.ok(tags)

      const mlAppEntries = tags.split(',').filter(entry => entry.startsWith('_dd.p.llmobs_ml_app='))
      assert.strictEqual(mlAppEntries.length, 1, `Expected exactly one _dd.p.llmobs_ml_app entry in: ${tags}`)
      assert.strictEqual(mlAppEntries[0], '_dd.p.llmobs_ml_app=downstream-app')

      const sidEntries = tags.split(',').filter(entry => entry.startsWith('_dd.p.llmobs_sid='))
      assert.strictEqual(sidEntries.length, 1, `Expected exactly one _dd.p.llmobs_sid entry in: ${tags}`)
      assert.strictEqual(sidEntries[0], '_dd.p.llmobs_sid=upstream-session')

      assert.ok(tags.includes('_dd.p.tid=69fe014200000000'))
      assert.ok(tags.includes('_dd.p.dm=-0'))
    })

    describe('with DD_TRACE_X_DATADOG_TAGS_MAX_LENGTH=0', () => {
      let config

      before(() => {
        process.env.DD_TRACE_X_DATADOG_TAGS_MAX_LENGTH = '0'
        config = getConfigFresh({ llmobs: { mlApp: 'test', agentlessEnabled: false } })
        delete process.env.DD_TRACE_X_DATADOG_TAGS_MAX_LENGTH
      })

      it('does not write x-datadog-tags', () => {
        llmobsModule.enable(config)

        const carrier = {}
        injectCh.publish({ carrier })

        assert.ok(!('x-datadog-tags' in carrier))
      })
    })
  })

  describe('with agentlessEnabled set to `true`', () => {
    describe('when no api key is provided', () => {
      it('throws an error', () => {
        llmobsModule.enable({
          llmobs: {
            agentlessEnabled: true,
          },
          startupLogs: true,
        })

        sinon.assert.calledWith(startupLogStub, INCOMPATIBLE_INITIALIZATION)
      })
    })

    describe('when no site is provided', () => {
      it('throws an error', () => {
        llmobsModule.enable({ llmobs: { agentlessEnabled: true, apiKey: 'test' }, startupLogs: true })

        sinon.assert.calledWith(startupLogStub, INCOMPATIBLE_INITIALIZATION)
      })
    })

    describe('if an api key is provided', () => {
      it('configures agentless writers', () => {
        llmobsModule.enable({
          llmobs: {
            agentlessEnabled: true,
          },
          DD_API_KEY: 'test',
          site: 'datadoghq.com',
        })

        sinon.assert.calledWith(LLMObsSpanWriterSpy().setAgentless, true)
        sinon.assert.calledWith(LLMObsEvalMetricsWriterSpy().setAgentless, true)
      })
    })
  })

  describe('with agentlessEnabled set to `false`', () => {
    it('configures agent-proxy writers', () => {
      llmobsModule.enable({
        llmobs: {
          agentlessEnabled: false,
        },
      })

      sinon.assert.calledWith(LLMObsSpanWriterSpy().setAgentless, false)
      sinon.assert.calledWith(LLMObsEvalMetricsWriterSpy().setAgentless, false)
    })
  })

  describe('with agentlessEnabled set to undefined', () => {
    afterEach(() => {
      sinon.restore()
    })

    describe('when an agent is running', () => {
      describe('when the agent does not have the correct proxy endpoint', () => {
        beforeEach(() => {
          fetchAgentInfoStub.callsFake((url, cb) => {
            cb(null, {})
          })
        })

        describe('when no API key is provided', () => {
          it('throws an error', () => {
            llmobsModule.enable({ llmobs: { mlApp: 'test', site: 'datadoghq.com' }, startupLogs: true })

            sinon.assert.calledWith(startupLogStub, INCOMPATIBLE_INITIALIZATION)
          })
        })

        describe('when no site is provided', () => {
          it('throws an error', () => {
            llmobsModule.enable({ llmobs: { mlApp: 'test', apiKey: 'test' }, startupLogs: true })

            sinon.assert.calledWith(startupLogStub, INCOMPATIBLE_INITIALIZATION)
          })
        })

        it('configures the agentless writers', () => {
          llmobsModule.enable({
            llmobs: {},
            DD_API_KEY: 'test',
            site: 'datadoghq.com',
          })

          sinon.assert.calledWith(LLMObsSpanWriterSpy().setAgentless, true)
          sinon.assert.calledWith(LLMObsEvalMetricsWriterSpy().setAgentless, true)
        })
      })

      describe('when the agent has the correct proxy endpoint', () => {
        beforeEach(() => {
          fetchAgentInfoStub.callsFake((url, cb) => {
            cb(null, { endpoints: ['/evp_proxy/v2/'] })
          })
        })

        it('configures the agent-proxy writers', () => {
          llmobsModule.enable({ llmobs: { mlApp: 'test' } })

          sinon.assert.calledWith(LLMObsSpanWriterSpy().setAgentless, false)
          sinon.assert.calledWith(LLMObsEvalMetricsWriterSpy().setAgentless, false)
        })
      })
    })

    describe('when no agent is running', () => {
      beforeEach(() => {
        fetchAgentInfoStub.callsFake((url, cb) => {
          cb(new Error('No agent running'))
        })
      })

      describe('when no API key is provided', () => {
        it('throws an error', () => {
          llmobsModule.enable({ llmobs: { mlApp: 'test', site: 'datadoghq.com' }, startupLogs: true })

          sinon.assert.calledWith(startupLogStub, INCOMPATIBLE_INITIALIZATION)
        })
      })

      describe('when no site is provided', () => {
        it('throws an error', () => {
          llmobsModule.enable({ llmobs: {}, DD_API_KEY: 'test', startupLogs: true })

          sinon.assert.calledWith(startupLogStub, INCOMPATIBLE_INITIALIZATION)
        })
      })

      describe('when an API key is provided', () => {
        it('configures the agentless writers', () => {
          llmobsModule.enable({ llmobs: {}, DD_API_KEY: 'test', site: 'datadoghq.com' })

          sinon.assert.calledWith(LLMObsSpanWriterSpy().setAgentless, true)
          sinon.assert.calledWith(LLMObsEvalMetricsWriterSpy().setAgentless, true)
        })
      })
    })
  })

  it('appends to the eval metric writer', () => {
    llmobsModule.enable({ llmobs: { mlApp: 'test', agentlessEnabled: false } })

    const payload = {}

    evalMetricAppendCh.publish({ payload })

    sinon.assert.calledWith(LLMObsEvalMetricsWriterSpy().append, payload, undefined)
  })

  it('registers both LLMObs writers for lifecycle flushing', () => {
    loadLlmobsModuleOnVercel()
    llmobsModule.enable({ llmobs: { mlApp: 'test', agentlessEnabled: false } })
    const done = sinon.spy()
    const spanWriter = LLMObsSpanWriterSpy.firstCall.returnValue
    const evalWriter = LLMObsEvalMetricsWriterSpy.firstCall.returnValue
    let flushSpan
    let flushEvaluation
    spanWriter.flush.callsFake(callback => { flushSpan = callback })
    evalWriter.flush.callsFake(callback => { flushEvaluation = callback })

    registerTelemetryFlusher.firstCall.args[0](done)

    sinon.assert.calledOnce(spanWriter.flush)
    sinon.assert.calledOnce(evalWriter.flush)
    flushSpan()
    sinon.assert.notCalled(done)
    flushEvaluation()
    sinon.assert.calledOnce(done)
  })

  it('continues flushing when one LLMObs writer throws', () => {
    loadLlmobsModuleOnVercel()
    llmobsModule.enable({ llmobs: { mlApp: 'test', agentlessEnabled: false } })
    const done = sinon.spy()
    const spanWriter = LLMObsSpanWriterSpy.firstCall.returnValue
    const evalWriter = LLMObsEvalMetricsWriterSpy.firstCall.returnValue
    spanWriter.flush.throws(new Error('bad payload'))
    evalWriter.flush.callsFake(callback => callback())

    registerTelemetryFlusher.firstCall.args[0](done)

    sinon.assert.calledOnce(evalWriter.flush)
    sinon.assert.calledOnce(done)
  })

  it('removes all subscribers when disabling', () => {
    llmobsModule.enable({ llmobs: { mlApp: 'test', agentlessEnabled: false } })

    llmobsModule.disable()

    assert.strictEqual(injectCh.hasSubscribers, false)
    assert.strictEqual(evalMetricAppendCh.hasSubscribers, false)
    assert.strictEqual(spanFinishCh.hasSubscribers, false)
    assert.strictEqual(flushCh.hasSubscribers, false)
    sinon.assert.calledOnce(unregisterTelemetryFlusher)
  })

  it('retains destroyed writers until every lifecycle flush completes', () => {
    loadLlmobsModuleOnVercel()
    const retiredUnregister = sinon.stub()
    registerTelemetryFlusher.onSecondCall().returns(retiredUnregister)
    llmobsModule.enable({ llmobs: { mlApp: 'test', agentlessEnabled: false } })
    const spanWriter = LLMObsSpanWriterSpy.firstCall.returnValue
    const evalWriter = LLMObsEvalMetricsWriterSpy.firstCall.returnValue
    let completeSpan
    let completeEvaluation
    spanWriter.destroy.callsFake(done => { completeSpan = done })
    evalWriter.destroy.callsFake(done => { completeEvaluation = done })

    llmobsModule.disable()

    sinon.assert.calledTwice(registerTelemetryFlusher)
    sinon.assert.notCalled(retiredUnregister)
    completeSpan()
    sinon.assert.notCalled(retiredUnregister)
    completeEvaluation()
    sinon.assert.calledOnce(retiredUnregister)
  })

  it('retires reinitialized writers until their destroy callbacks complete', () => {
    loadLlmobsModuleOnVercel()
    const initialUnregister = sinon.stub()
    const retiredUnregister = sinon.stub()
    const replacementUnregister = sinon.stub()
    registerTelemetryFlusher.onCall(0).returns(initialUnregister)
    registerTelemetryFlusher.onCall(1).returns(retiredUnregister)
    registerTelemetryFlusher.onCall(2).returns(replacementUnregister)
    llmobsModule.enable({ llmobs: { mlApp: 'test', agentlessEnabled: false } })
    const spanWriter = LLMObsSpanWriterSpy.firstCall.returnValue
    const evalWriter = LLMObsEvalMetricsWriterSpy.firstCall.returnValue
    let destroySpan
    let destroyEvaluation
    spanWriter.destroy.callsFake(done => { destroySpan = done })
    evalWriter.destroy.callsFake(done => { destroyEvaluation = done })

    llmobsModule.enable({ llmobs: { mlApp: 'test', agentlessEnabled: false } })

    sinon.assert.calledOnce(initialUnregister)
    sinon.assert.calledThrice(registerTelemetryFlusher)
    sinon.assert.notCalled(retiredUnregister)
    spanWriter.flush.callsFake(done => done())
    evalWriter.flush.callsFake(done => done())
    const done = sinon.spy()
    registerTelemetryFlusher.secondCall.args[0](done)
    sinon.assert.calledOnce(spanWriter.flush)
    sinon.assert.calledOnce(evalWriter.flush)
    sinon.assert.calledOnce(done)
    destroySpan()
    sinon.assert.notCalled(retiredUnregister)
    destroyEvaluation()
    sinon.assert.calledOnce(retiredUnregister)
  })

  it('completes transport selection for writers retired during initialization', () => {
    loadLlmobsModuleOnVercel()
    llmobsModule.enable({ llmobs: { mlApp: 'test' } })
    const spanWriter = LLMObsSpanWriterSpy.firstCall.returnValue
    const evalWriter = LLMObsEvalMetricsWriterSpy.firstCall.returnValue

    llmobsModule.disable()
    fetchAgentInfoStub.firstCall.args[1](null, { endpoints: ['/evp_proxy/v2/'] })

    sinon.assert.calledWith(spanWriter.setAgentless, false)
    sinon.assert.calledWith(evalWriter.setAgentless, false)
  })
})
