'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const { DD_MAJOR } = require('../../../../version')
const { INCOMPATIBLE_INITIALIZATION } = require('../../src/llmobs/constants/text')
const LLMObsTagger = require('../../src/llmobs/tagger')
const { SAMPLE_RATE, SAMPLING_DECISION } = require('../../src/llmobs/constants/tags')
const { getConfigFresh } = require('../helpers/config')
const { removeDestroyHandler } = require('./util')

const spanFinishCh = channel('dd-trace:span:finish')
const traceSampledCh = channel('dd-trace:trace:sampled')
const evalMetricAppendCh = channel('llmobs:eval-metric:append')
const flushCh = channel('llmobs:writers:flush')
const injectCh = channel('dd-trace:span:inject')

describe('module', () => {
  let llmobsModule
  let store
  let logger

  let LLMObsSpanWriterSpy
  let LLMObsEvalMetricsWriterSpy
  let LLMObsSpanProcessorSpy
  let llmobsSpanProcessor
  let fetchAgentInfoStub
  let tracer

  /** @type {import('sinon').SinonStub} */
  let startupLogStub

  beforeEach(() => {
    store = {}
    logger = { debug: sinon.stub() }

    LLMObsSpanWriterSpy = sinon.stub().returns({
      destroy: sinon.stub(),
      setAgentless: sinon.stub(),
    })

    LLMObsEvalMetricsWriterSpy = sinon.stub().returns({
      destroy: sinon.stub(),
      append: sinon.stub(),
      setAgentless: sinon.stub(),
    })

    llmobsSpanProcessor = {
      process: sinon.stub(),
      processSampledTrace: sinon.stub(),
      setUserSpanProcessor: sinon.stub(),
      setWriter: sinon.stub(),
    }
    LLMObsSpanProcessorSpy = sinon.stub().returns(llmobsSpanProcessor)

    fetchAgentInfoStub = sinon.stub()
    tracer = {
      configureExporter: sinon.stub(),
    }

    const llmobsModuleProxyRequireMeta = {
      './writers/spans': LLMObsSpanWriterSpy,
      './writers/evaluations': LLMObsEvalMetricsWriterSpy,
      './span_processor': LLMObsSpanProcessorSpy,
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

    llmobsModule = proxyquire('../../../dd-trace/src/llmobs', llmobsModuleProxyRequireMeta)

    removeDestroyHandler()
  })

  afterEach(() => {
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
        sinon.assert.calledWith(
          logger.debug,
          '[LLMObs] Using %s writer transport for span and evaluation events',
          'agentless/direct intake'
        )
      })

      it('configures APM agentless export when APM tracing is enabled', () => {
        const config = getConfigFresh({
          llmobs: {
            agentlessEnabled: true,
          },
        })
        tracer.configureExporter.returns(true)

        llmobsModule.enable(config, tracer)

        assert.strictEqual(config.experimental.exporter, 'agentless')
        assert.strictEqual(config.getOrigin('experimental.exporter'), 'calculated')
        sinon.assert.calledWith(tracer.configureExporter, config, 'agentless')
        sinon.assert.calledWith(logger.debug, '[LLMObs] Swapped APM trace exporter to agentless intake')
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
      sinon.assert.calledWith(
        logger.debug,
        '[LLMObs] Using %s writer transport for span and evaluation events',
        'Agent EVP proxy'
      )
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

        it('configures APM agentless export when APM tracing is enabled', () => {
          const config = getConfigFresh()
          config.DD_API_KEY = 'test'
          config.site = 'datadoghq.com'

          llmobsModule.enable(config, tracer)

          assert.notStrictEqual(config.experimental.exporter, 'agentless')
          sinon.assert.calledWith(tracer.configureExporter, config, 'agentless')
        })
      })

      describe('when the agent has the correct proxy endpoint', () => {
        beforeEach(() => {
          fetchAgentInfoStub.callsFake((url, cb) => {
            cb(null, { endpoints: ['/evp_proxy/v2'] })
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

        it('configures APM agentless export when APM tracing is enabled', () => {
          const config = getConfigFresh()
          config.DD_API_KEY = 'test'
          config.site = 'datadoghq.com'

          llmobsModule.enable(config, tracer)

          assert.notStrictEqual(config.experimental.exporter, 'agentless')
          sinon.assert.calledWith(tracer.configureExporter, config, 'agentless')
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

  it('processes sampled trace chunks through the LLMObs span processor', () => {
    llmobsModule.enable({ llmobs: { mlApp: 'test', agentlessEnabled: false } })
    const spans = [{ name: 'root' }]

    traceSampledCh.publish({ spans })

    sinon.assert.calledOnceWithExactly(llmobsSpanProcessor.processSampledTrace, spans)
  })

  it('removes all subscribers when disabling', () => {
    llmobsModule.enable({ llmobs: { mlApp: 'test', agentlessEnabled: false } })

    llmobsModule.disable()

    assert.strictEqual(injectCh.hasSubscribers, false)
    assert.strictEqual(evalMetricAppendCh.hasSubscribers, false)
    assert.strictEqual(spanFinishCh.hasSubscribers, false)
    assert.strictEqual(traceSampledCh.hasSubscribers, false)
    assert.strictEqual(flushCh.hasSubscribers, false)
  })
})
