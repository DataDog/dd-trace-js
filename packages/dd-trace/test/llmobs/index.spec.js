'use strict'

const proxyquire = require('proxyquire')
const { channel } = require('dc-polyfill')
const injectCh = channel('dd-trace:span:inject')

describe('module', () => {
  let llmobsModule
  let store
  let logger

  beforeEach(() => {
    store = {}
    logger = { debug: sinon.stub() }
    llmobsModule = proxyquire('../../../dd-trace/src/llmobs', {
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

  it('injects LLMObs parent ID when there is a parent LLMObs span', () => {
    llmobsModule.enable({})
    store.llmobsSpan = {
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
    llmobsModule.enable({})

    const carrier = {
      'x-datadog-tags': ''
    }
    injectCh.publish({ carrier })
    expect(logger.debug).to.have.been.calledWith('No active span to inject LLMObs info.')
    expect(carrier['x-datadog-tags']).to.equal('')
  })

  it('does nothing after being disabled', () => {
    const before = injectCh._subscribers.length
    llmobsModule.enable({})
    const during = injectCh._subscribers.length
    llmobsModule.disable()
    const after = injectCh._subscribers.length

    expect(during).to.equal(before + 1)
    expect(after).to.equal(before)
  })
})
