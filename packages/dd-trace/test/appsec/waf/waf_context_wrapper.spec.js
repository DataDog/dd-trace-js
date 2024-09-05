'use strict'

const proxyquire = require('proxyquire')
const WAFContextWrapper = require('../../../src/appsec/waf/waf_context_wrapper')
const addresses = require('../../../src/appsec/addresses')

describe('WAFContextWrapper', () => {
  it('Should send HTTP_INCOMING_QUERY only once', () => {
    const ddwafContext = {
      run: sinon.stub()
    }
    const wafContextWrapper = new WAFContextWrapper(ddwafContext, 1000, '1.14.0', '1.8.0')

    const payload = {
      persistent: {
        [addresses.HTTP_INCOMING_QUERY]: { key: 'value' }
      }
    }

    wafContextWrapper.run(payload)
    wafContextWrapper.run(payload)

    expect(ddwafContext.run).to.have.been.calledOnceWithExactly(payload, 1000)
  })

  it('Should send ephemeral addreses every time', () => {
    const ddwafContext = {
      run: sinon.stub()
    }
    const wafContextWrapper = new WAFContextWrapper(ddwafContext, 1000, '1.14.0', '1.8.0')

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

      wafContextWrapper = new ProxiedWafContextWrapper(ddwafContext, 1000, '1.14.0', '1.8.0')
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
    })

    it('Should not call run if context is disposed', () => {
      ddwafContext.disposed = true

      const payload = {
        persistent: {
          [addresses.HTTP_INCOMING_QUERY]: { key: 'value' }
        }
      }

      wafContextWrapper.run(payload)

      sinon.assert.notCalled(ddwafContext.run)
    })

    it('Should log a warn when attempting to call run on a disposed context', () => {
      ddwafContext.disposed = true

      const payload = {
        persistent: {
          [addresses.HTTP_INCOMING_QUERY]: { key: 'value' }
        }
      }

      wafContextWrapper.run(payload)

      sinon.assert.calledOnceWithExactly(log.warn, 'Calling run on a disposed context')
    })
  })
})
