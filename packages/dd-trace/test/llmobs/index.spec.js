'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const { after, afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

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

  beforeEach(() => {
    store = {}
    logger = { debug: sinon.stub() }

    LLMObsSpanWriterSpy = sinon.stub().returns({
      destroy: sinon.stub(),
      setAgentless: sinon.stub()
    })

    LLMObsEvalMetricsWriterSpy = sinon.stub().returns({
      destroy: sinon.stub(),
      append: sinon.stub(),
      setAgentless: sinon.stub()
    })

    fetchAgentInfoStub = sinon.stub()

    llmobsModule = proxyquire('../../../dd-trace/src/llmobs', {
      './writers/spans': LLMObsSpanWriterSpy,
      './writers/evaluations': LLMObsEvalMetricsWriterSpy,
      '../log': logger,
      './storage': {
        storage: {
          getStore () {
            return store
          }
        }
      },
      './writers/util': proxyquire('../../../dd-trace/src/llmobs/writers/util', {
        '../../agent/info': {
          fetchAgentInfo: fetchAgentInfoStub
        }
      })
    })

    removeDestroyHandler()
  })

  afterEach(() => {
    llmobsModule.disable()
  })

  after(() => {
    sinon.restore()

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
            }
          }
        }
      }

      const carrier = {
        'x-datadog-tags': ''
      }
      injectCh.publish({ carrier })

      assert.strictEqual(carrier['x-datadog-tags'], ',_dd.p.llmobs_parent_id=parent-id,_dd.p.llmobs_ml_app=test')
    })

    it('does not inject LLMObs parent ID info when there is no parent LLMObs span', () => {
      llmobsModule.enable({ llmobs: { mlApp: 'test', agentlessEnabled: false } })

      const carrier = {
        'x-datadog-tags': ''
      }
      injectCh.publish({ carrier })
      assert.strictEqual(carrier['x-datadog-tags'], ',_dd.p.llmobs_ml_app=test')
    })

    it('does not inject LLMOBs info when there is no mlApp configured and no parent LLMObs span', () => {
      llmobsModule.enable({ llmobs: { agentlessEnabled: false } })

      const carrier = {
        'x-datadog-tags': ''
      }
      injectCh.publish({ carrier })
      assert.strictEqual(carrier['x-datadog-tags'], '')
    })
  })

  describe('with agentlessEnabled set to `true`', () => {
    describe('when no api key is provided', () => {
      it('throws an error', () => {
        assert.throws(() => llmobsModule.enable({
          llmobs: {
            agentlessEnabled: true
          }
        }),
        {
          message: 'Cannot send LLM Observability data without a running agent ' +
            'or without both a Datadog API key and site.\n' +
            'Ensure these configurations are set before running your application.'
        })
      })
    })

    describe('when no site is provided', () => {
      it('throws an error', () => {
        assert.throws(() => llmobsModule.enable({ llmobs: { agentlessEnabled: true, apiKey: 'test' } }))
      })
    })

    describe('if an api key is provided', () => {
      it('configures agentless writers', () => {
        llmobsModule.enable({
          llmobs: {
            agentlessEnabled: true
          },
          apiKey: 'test',
          site: 'datadoghq.com'
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
          agentlessEnabled: false
        }
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
            assert.throws(() => llmobsModule.enable({ llmobs: { mlApp: 'test', site: 'datadoghq.com' } }))
          })
        })

        describe('when no site is provided', () => {
          it('throws an error', () => {
            assert.throws(() => llmobsModule.enable({ llmobs: { mlApp: 'test', apiKey: 'test' } }))
          })
        })

        it('configures the agentless writers', () => {
          llmobsModule.enable({
            llmobs: {},
            apiKey: 'test',
            site: 'datadoghq.com'
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
          assert.throws(
            () => llmobsModule.enable({ llmobs: { mlApp: 'test', site: 'datadoghq.com' } }),
            {
              message: 'Cannot send LLM Observability data without a running agent ' +
                'or without both a Datadog API key and site.\n' +
                'Ensure these configurations are set before running your application.'
            }
          )
        })
      })

      describe('when no site is provided', () => {
        it('throws an error', () => {
          assert.throws(() => llmobsModule.enable({ llmobs: {}, apiKey: 'test' }))
        })
      })

      describe('when an API key is provided', () => {
        it('configures the agentless writers', () => {
          llmobsModule.enable({ llmobs: {}, apiKey: 'test', site: 'datadoghq.com' })

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

  it('removes all subscribers when disabling', () => {
    llmobsModule.enable({ llmobs: { mlApp: 'test', agentlessEnabled: false } })

    llmobsModule.disable()

    assert.strictEqual(injectCh.hasSubscribers, false)
    assert.strictEqual(evalMetricAppendCh.hasSubscribers, false)
    assert.strictEqual(spanFinishCh.hasSubscribers, false)
    assert.strictEqual(flushCh.hasSubscribers, false)
  })
})
