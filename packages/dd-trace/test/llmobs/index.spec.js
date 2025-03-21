'use strict'

const proxyquire = require('proxyquire')

const { channel } = require('dc-polyfill')
const spanProcessCh = channel('dd-trace:span:process')
const evalMetricAppendCh = channel('llmobs:eval-metric:append')
const flushCh = channel('llmobs:writers:flush')
const injectCh = channel('dd-trace:span:inject')

const config = {
  llmobs: {
    mlApp: 'test'
  },
  apiKey: 'test',
  site: 'datadoghq.com'
}

describe('module', () => {
  let llmobsModule
  let store
  let logger

  let LLMObsSpanWriterSpy
  let LLMObsEvalMetricsWriterSpy

  beforeEach(() => {
    store = {}
    logger = { debug: sinon.stub() }

    LLMObsSpanWriterSpy = sinon.stub().returns({
      destroy: sinon.stub()
    })

    LLMObsEvalMetricsWriterSpy = sinon.stub().returns({
      destroy: sinon.stub(),
      append: sinon.stub()
    })

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
      }
    })

    process.removeAllListeners('beforeExit')
    process.removeAllListeners('uncaughtException')
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
    it('injects LLMObs parent ID when there is a parent LLMObs span', () => {
      llmobsModule.enable(config)
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

      expect(carrier['x-datadog-tags']).to.equal(',_dd.p.llmobs_parent_id=parent-id')
    })

    it('does not inject LLMObs parent ID when there is no parent LLMObs span', () => {
      llmobsModule.enable(config)

      const carrier = {
        'x-datadog-tags': ''
      }
      injectCh.publish({ carrier })
      expect(carrier['x-datadog-tags']).to.equal('')
    })
  })

  describe('with agentlessEnabled set to `true`', () => {
    beforeEach(() => {
      config.llmobs.agentlessEnabled = true
    })

    afterEach(() => {
      delete config.llmobs.agentlessEnabled
    })

    it('throws if no api key is provided', () => {})

    it('configures agentless writers', () => {})
  })

  describe('with agentlessEnabled set to `false`', () => {
    beforeEach(() => {
      config.llmobs.agentlessEnabled = false
    })

    afterEach(() => {
      delete config.llmobs.agentlessEnabled
    })

    it('configures agent-proxy writers', () => {})
  })

  describe('with agentlessEnabled set to undefined', () => {
    describe('when an agent is running', () => {
      it('configures the agent-proxy writers', () => {})
    })

    describe('when no agent is running', () => {
      describe('when no API key is provided', () => {
        it('throws an error', () => {})
      })

      describe('when an API key is provided', () => {
        it('configures the agentless writers', () => {})
      })
    })
  })

  it('appends to the eval metric writer', () => {
    llmobsModule.enable(config)

    const payload = {}

    evalMetricAppendCh.publish(payload)

    expect(LLMObsEvalMetricsWriterSpy().append).to.have.been.calledWith(payload)
  })

  it('removes all subscribers when disabling', () => {
    llmobsModule.enable(config)

    llmobsModule.disable()

    expect(injectCh.hasSubscribers).to.be.false
    expect(evalMetricAppendCh.hasSubscribers).to.be.false
    expect(spanProcessCh.hasSubscribers).to.be.false
    expect(flushCh.hasSubscribers).to.be.false
  })
})
