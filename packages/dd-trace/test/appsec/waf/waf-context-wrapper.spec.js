'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')
const WAFContextWrapper = require('../../../src/appsec/waf/waf-context-wrapper')
const addresses = require('../../../src/appsec/addresses')
const { wafRunFinished } = require('../../../src/appsec/channels')
const Reporter = require('../../../src/appsec/reporter')

describe('WAFContextWrapper', () => {
  const knownAddresses = new Set([
    addresses.HTTP_INCOMING_QUERY,
    addresses.HTTP_INCOMING_GRAPHQL_RESOLVER
  ])

  beforeEach(() => {
    sinon.stub(Reporter, 'reportMetrics')
    sinon.stub(Reporter, 'reportRaspRuleSkipped')
  })

  afterEach(() => {
    sinon.restore()
  })

  it('Should send HTTP_INCOMING_QUERY only once', () => {
    const ddwafContext = {
      run: sinon.stub().returns({
        events: {},
        attributes: {}
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
    expect(Reporter.reportMetrics).to.have.been.calledOnce
  })

  it('Should send HTTP_INCOMING_QUERY twice if waf run fails', () => {
    const ddwafContext = {
      run: sinon.stub().throws(new Error('test'))
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
    expect(ddwafContext.run).to.always.have.been.calledWithExactly(payload, 1000)

    const firstCall = Reporter.reportMetrics.getCall(0).args[0]
    expect(firstCall).to.have.property('errorCode', -127)

    const secondCall = Reporter.reportMetrics.getCall(1).args[0]
    expect(secondCall).to.have.property('errorCode', -127)
  })

  it('Should send ephemeral addresses every time', () => {
    const ddwafContext = {
      run: sinon.stub().returns({
        events: {},
        attributes: {}
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
    expect(Reporter.reportMetrics).to.have.been.calledTwice
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

    expect(ddwafContext.run).to.not.have.been.called
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

  it('should report error code when the waf run fails', () => {
    const ddwafContext = {
      run: sinon.stub().returns({ errorCode: -2 })
    }

    const wafContextWrapper = new WAFContextWrapper(ddwafContext, 1000, '1.14.0', '1.8.0', knownAddresses)

    const payload = {
      persistent: {
        [addresses.HTTP_INCOMING_QUERY]: { key: 'value' }
      }
    }

    wafContextWrapper.run(payload)

    expect(Reporter.reportMetrics).to.have.been.calledOnce
    const reportedMetrics = Reporter.reportMetrics.getCall(0).args[0]

    expect(reportedMetrics).to.include({
      rulesVersion: '1.8.0',
      wafVersion: '1.14.0',
      wafTimeout: false,
      blockTriggered: false,
      ruleTriggered: false,
      errorCode: -2,
      maxTruncatedString: null,
      maxTruncatedContainerSize: null,
      maxTruncatedContainerDepth: null
    })
  })

  it('should report truncation metrics, blockTriggered, and ruleTriggered on successful waf run', () => {
    const ddwafContext = {
      run: sinon.stub().returns({
        events: [{ rule_matches: [] }],
        attributes: [],
        actions: {
          redirect_request: {
            status_code: 301
          }
        },
        duration: 123456,
        timeout: false,
        metrics: {
          maxTruncatedString: 5000,
          maxTruncatedContainerSize: 300,
          maxTruncatedContainerDepth: 20
        }
      })
    }

    const wafContextWrapper = new WAFContextWrapper(ddwafContext, 1000, '1.14.0', '1.8.0', knownAddresses)

    const payload = {
      persistent: {
        [addresses.HTTP_INCOMING_QUERY]: { key: 'value' }
      }
    }

    wafContextWrapper.run(payload)

    expect(Reporter.reportMetrics).to.have.been.calledOnce
    const reportedMetrics = Reporter.reportMetrics.getCall(0).args[0]

    expect(reportedMetrics).to.include({
      rulesVersion: '1.8.0',
      wafVersion: '1.14.0',
      wafTimeout: false,
      blockTriggered: true,
      ruleTriggered: true,
      errorCode: null,
      maxTruncatedString: 5000,
      maxTruncatedContainerSize: 300,
      maxTruncatedContainerDepth: 20
    })
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

      const ProxiedWafContextWrapper = proxyquire('../../../src/appsec/waf/waf-context-wrapper', {
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
      expect(Reporter.reportMetrics).to.have.been.calledOnce
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
      expect(Reporter.reportRaspRuleSkipped).to.not.have.been.called
      expect(Reporter.reportMetrics).to.not.have.been.called
    })

    it('Should call run with raspRule and call reportRaspRuleSkipped if context is disposed', () => {
      ddwafContext.disposed = true

      const payload = {
        persistent: {
          [addresses.HTTP_INCOMING_QUERY]: { key: 'value' }
        }
      }

      const raspRule = { type: 'rule-type' }
      wafContextWrapper.run(payload, raspRule)

      sinon.assert.notCalled(ddwafContext.run)
      sinon.assert.calledOnceWithExactly(log.warn, '[ASM] Calling run on a disposed context')
      expect(Reporter.reportRaspRuleSkipped).to.have.been.calledOnceWithExactly(raspRule, 'after-request')
      expect(Reporter.reportMetrics).to.not.have.been.called
    })
  })
})
