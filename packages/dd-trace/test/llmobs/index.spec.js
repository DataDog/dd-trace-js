'use strict'

const proxyquire = require('proxyquire')

const { channel } = require('dc-polyfill')
const spanProcessCh = channel('dd-trace:span:process')
const evalMetricAppendCh = channel('llmobs:eval-metric:append')
const flushCh = channel('llmobs:writers:flush')
const injectCh = channel('dd-trace:span:inject')

const LLMObsEvalMetricsWriter = require('../../src/llmobs/writers/evaluations')

const config = {
  llmobs: {
    mlApp: 'test'
  }
}

describe('module', () => {
  let llmobsModule
  let store
  let logger

  let LLMObsAgentlessSpanWriter
  let LLMObsAgentProxySpanWriter

  before(() => {
    sinon.stub(LLMObsEvalMetricsWriter.prototype, 'append')
  })

  beforeEach(() => {
    store = {}
    logger = { debug: sinon.stub() }

    LLMObsAgentlessSpanWriter = sinon.stub().returns({
      destroy: sinon.stub()
    })
    LLMObsAgentProxySpanWriter = sinon.stub().returns({
      destroy: sinon.stub()
    })

    llmobsModule = proxyquire('../../../dd-trace/src/llmobs', {
      '../log': logger,
      './writers/spans/agentless': LLMObsAgentlessSpanWriter,
      './writers/spans/agentProxy': LLMObsAgentProxySpanWriter,
      './storage': {
        storage: {
          getStore () {
            return store
          }
        }
      }
    })

    process.removeAllListeners('beforeExit')
  })

  afterEach(() => {
    LLMObsAgentProxySpanWriter.resetHistory()
    LLMObsAgentlessSpanWriter.resetHistory()
    LLMObsEvalMetricsWriter.prototype.append.resetHistory()
    llmobsModule.disable()
  })

  after(() => {
    LLMObsEvalMetricsWriter.prototype.append.restore()
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

  it('uses the agent proxy span writer', () => {
    llmobsModule.enable(config)
    expect(LLMObsAgentProxySpanWriter).to.have.been.called
  })

  it('uses the agentless span writer', () => {
    config.llmobs.agentlessEnabled = true
    llmobsModule.enable(config)
    expect(LLMObsAgentlessSpanWriter).to.have.been.called
    delete config.llmobs.agentlessEnabled
  })

  it('appends to the eval metric writer', () => {
    llmobsModule.enable(config)

    const payload = {}

    evalMetricAppendCh.publish(payload)

    expect(LLMObsEvalMetricsWriter.prototype.append).to.have.been.calledWith(payload)
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
