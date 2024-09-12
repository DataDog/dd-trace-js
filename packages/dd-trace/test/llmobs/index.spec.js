'use strict'

const proxyquire = require('proxyquire')

describe('module', () => {
  let llmobsModule
  let llmobsSpanStartCh
  let llmobsSpanEndCh
  let llmobsSpanErrorCh
  let injectCh
  let handleSpanStart
  let handleSpanEnd
  let handleSpanError
  let registerPlugins
  let logger

  let handleLLMObsParentIdInjection
  let store

  function createStubChannel () {
    const ch = {}

    ch._subscriberCount = 0
    ch.subscribe = sinon.stub().callsFake((handler) => {
      if (handler.name === 'handleLLMObsParentIdInjection') {
        handleLLMObsParentIdInjection = handler
      }
      ch._subscriberCount++
    })
    ch.unsubscribe = sinon.stub()

    Object.defineProperty(ch, 'hasSubscribers', {
      get () {
        return ch._subscriberCount > 0
      }
    })

    return ch
  }

  beforeEach(() => {
    llmobsSpanStartCh = createStubChannel()
    llmobsSpanEndCh = createStubChannel()
    llmobsSpanErrorCh = createStubChannel()
    injectCh = createStubChannel()

    handleSpanStart = sinon.stub()
    handleSpanEnd = sinon.stub()
    handleSpanError = sinon.stub()
    registerPlugins = sinon.stub()

    logger = {
      warn: sinon.stub()
    }

    store = {}
    llmobsModule = proxyquire('../../src/llmobs', {
      './integrations/channels': {
        llmobsSpanStartCh,
        llmobsSpanEndCh,
        llmobsSpanErrorCh,
        injectCh
      },
      './integrations': {
        handleSpanStart,
        handleSpanEnd,
        handleSpanError,
        registerPlugins
      },
      '../log': logger,
      '../../../datadog-core': {
        storage: {
          getStore () {
            return store
          }
        }
      }
    })
  })

  after(() => {
    // this will cause integration tests to error otherwise
    delete require.cache[require.resolve('../../src/llmobs')]
  })

  it('enables', () => {
    const config = {}
    llmobsModule.enable(config)

    expect(registerPlugins).to.have.been.calledWith(config)
    expect(llmobsSpanStartCh.subscribe).to.have.been.calledWith(handleSpanStart)
    expect(llmobsSpanEndCh.subscribe).to.have.been.calledWith(handleSpanEnd)
    expect(llmobsSpanErrorCh.subscribe).to.have.been.calledWith(handleSpanError)
    expect(injectCh.subscribe).to.have.been.calledWith(handleLLMObsParentIdInjection)
  })

  it('disables without active subscribers', () => {
    llmobsModule.disable()

    expect(llmobsSpanStartCh.unsubscribe).to.not.have.been.called
    expect(llmobsSpanEndCh.unsubscribe).to.not.have.been.called
    expect(llmobsSpanErrorCh.unsubscribe).to.not.have.been.called
    expect(injectCh.unsubscribe).to.not.have.been.called
  })

  it('disables with active subscribers', () => {
    llmobsModule.enable({})
    llmobsModule.disable()

    expect(llmobsSpanStartCh.unsubscribe).to.have.been.calledWith(handleSpanStart)
    expect(llmobsSpanEndCh.unsubscribe).to.have.been.calledWith(handleSpanEnd)
    expect(llmobsSpanErrorCh.unsubscribe).to.have.been.calledWith(handleSpanError)
    expect(injectCh.unsubscribe).to.have.been.calledWith(handleLLMObsParentIdInjection)
  })

  it('injects LLMObs parent ID when there is a parent LLMObs span', () => {
    llmobsModule.enable({})
    store.llmobsSpan = {
      context () {
        return {
          toSpanId () {
            return 'parent-id'
          },
          _tags: {
            '_ml_obs.trace_id': 'trace-id'
          }
        }
      }
    }

    const carrier = {
      'x-datadog-tags': ''
    }
    handleLLMObsParentIdInjection({ carrier })

    expect(carrier['x-datadog-tags']).to.equal(',_dd.p.llmobs_parent_id=parent-id,_dd.p.llmobs_trace_id=trace-id')
  })

  it('does not inject LLMObs parent ID when there is no parent LLMObs span', () => {
    llmobsModule.enable({})

    const carrier = {
      'x-datadog-tags': ''
    }
    handleLLMObsParentIdInjection({ carrier })
    expect(logger.warn).to.have.been.calledWith('No active span to inject LLMObs info.')
    expect(carrier['x-datadog-tags']).to.equal('')
  })
})
