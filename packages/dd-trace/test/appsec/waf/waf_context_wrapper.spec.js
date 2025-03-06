'use strict'

const proxyquire = require('proxyquire')
const WAFContextWrapper = require('../../../src/appsec/waf/waf_context_wrapper')
const addresses = require('../../../src/appsec/addresses')
const { wafRunFinished } = require('../../../src/appsec/channels')
const Reporter = require('../../../src/appsec/reporter')

describe('WAFContextWrapper', () => {
  const knownAddresses = new Set([
    addresses.HTTP_INCOMING_QUERY,
    addresses.HTTP_INCOMING_GRAPHQL_RESOLVER
  ])

  let reportMetricsStub

  before(() => {
    reportMetricsStub = sinon.stub(Reporter, 'reportMetrics')
  })

  afterEach(() => {
    reportMetricsStub.resetHistory()
  })

  it('Should send HTTP_INCOMING_QUERY only once', () => {
    const ddwafContext = {
      run: sinon.stub().returns({
        events: {},
        derivatives: {}
      })
    }
    const wafContextWrapper = new WAFContextWrapper(ddwafContext, 1000, '1.14.0', '1.8.0', knownAddresses)

    const payload = {
      persistent: {
        [addresses.HTTP_INCOMING_QUERY]: { key: 'value' }
      }
    }

    wafContextWrapper.run(payload)
    wafContextWrapper.run(payload)

    expect(ddwafContext.run).to.have.been.calledOnceWithExactly(payload, 1000)
    expect(reportMetricsStub).to.have.been.calledOnce
  })

  it('Should send HTTP_INCOMING_QUERY twice if waf run returns null', () => {
    const ddwafContext = {
      run: sinon.stub()
    }
    const wafContextWrapper = new WAFContextWrapper(ddwafContext, 1000, '1.14.0', '1.8.0', knownAddresses)

    const payload = {
      persistent: {
        [addresses.HTTP_INCOMING_QUERY]: { key: 'value' }
      }
    }

    wafContextWrapper.run(payload)
    wafContextWrapper.run(payload)

    expect(ddwafContext.run).to.have.been.calledTwice
    expect(ddwafContext.run).to.have.been.calledWithExactly(payload, 1000)

    const firstCall = reportMetricsStub.getCall(0).args[0]
    expect(firstCall).to.have.property('errorCode')
    expect(firstCall.errorCode).to.equal(-127)

    const secondCall = reportMetricsStub.getCall(1).args[0]
    expect(secondCall).to.have.property('errorCode')
    expect(secondCall.errorCode).to.equal(-127)
  })

  it('Should send ephemeral addresses every time', () => {
    const ddwafContext = {
      run: sinon.stub().returns({
        events: {},
        derivatives: {}
      })
    }
    const wafContextWrapper = new WAFContextWrapper(ddwafContext, 1000, '1.14.0', '1.8.0', knownAddresses)

    const payload = {
      persistent: {
        [addresses.HTTP_INCOMING_QUERY]: { key: 'value' }
      },
      ephemeral: {
        [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: { anotherKey: 'anotherValue' }
      }
    }

    wafContextWrapper.run(payload)
    wafContextWrapper.run(payload)

    expect(ddwafContext.run).to.have.been.calledTwice
    expect(ddwafContext.run.firstCall).to.have.been.calledWithExactly(payload, 1000)
    expect(ddwafContext.run.secondCall).to.have.been.calledWithExactly({
      ephemeral: {
        [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: {
          anotherKey: 'anotherValue'
        }
      }
    }, 1000)
    expect(reportMetricsStub).to.have.been.calledTwice
  })

  it('Should ignore run without known addresses', () => {
    const ddwafContext = {
      run: sinon.stub()
    }
    const wafContextWrapper = new WAFContextWrapper(ddwafContext, 1000, '1.14.0', '1.8.0', knownAddresses)

    const payload = {
      persistent: {
        'persistent-unknown-address': { key: 'value' }
      },
      ephemeral: {
        'ephemeral-unknown-address': { key: 'value' }
      }
    }

    wafContextWrapper.run(payload)

    expect(ddwafContext.run).to.have.not.been.called
  })

  it('should publish the payload in the dc channel', () => {
    const ddwafContext = {
      run: sinon.stub().returns([])
    }
    const wafContextWrapper = new WAFContextWrapper(ddwafContext, 1000, '1.14.0', '1.8.0', knownAddresses)
    const payload = {
      persistent: {
        [addresses.HTTP_INCOMING_QUERY]: { key: 'value' }
      },
      ephemeral: {
        [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: { anotherKey: 'anotherValue' }
      }
    }
    const finishedCallback = sinon.stub()

    wafRunFinished.subscribe(finishedCallback)
    wafContextWrapper.run(payload)
    wafRunFinished.unsubscribe(finishedCallback)

    expect(finishedCallback).to.be.calledOnceWith({ payload })
  })

  describe('Disposal context check', () => {
    let log
    let ddwafContext
    let wafContextWrapper

    beforeEach(() => {
      log = {
        warn: sinon.stub()
      }

      ddwafContext = {
        run: sinon.stub()
      }

      const ProxiedWafContextWrapper = proxyquire('../../../src/appsec/waf/waf_context_wrapper', {
        '../../log': log
      })

      wafContextWrapper = new ProxiedWafContextWrapper(ddwafContext, 1000, '1.14.0', '1.8.0', knownAddresses)
    })

    afterEach(() => {
      sinon.restore()
    })

    it('Should call run if context is not disposed', () => {
      ddwafContext.disposed = false

      const payload = {
        persistent: {
          [addresses.HTTP_INCOMING_QUERY]: { key: 'value' }
        }
      }

      wafContextWrapper.run(payload)

      sinon.assert.calledOnce(ddwafContext.run)
      expect(reportMetricsStub).to.have.been.calledOnce
    })

    it('Should not call run and log a warn if context is disposed', () => {
      ddwafContext.disposed = true

      const payload = {
        persistent: {
          [addresses.HTTP_INCOMING_QUERY]: { key: 'value' }
        }
      }

      wafContextWrapper.run(payload)

      sinon.assert.notCalled(ddwafContext.run)
      sinon.assert.calledOnceWithExactly(log.warn, '[ASM] Calling run on a disposed context')
      expect(reportMetricsStub).to.not.have.been.called
    })
  })
})
