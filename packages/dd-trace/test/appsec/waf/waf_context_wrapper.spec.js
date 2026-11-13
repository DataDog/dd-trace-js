'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const addresses = require('../../../src/appsec/addresses')
const { wafRunFinished } = require('../../../src/appsec/channels')
const Reporter = require('../../../src/appsec/reporter')
const WAFContextWrapper = require('../../../src/appsec/waf/waf_context_wrapper')
const { assertObjectContains } = require('../../../../../integration-tests/helpers')

describe('WAFContextWrapper', () => {
  const knownAddresses = new Set([
    addresses.HTTP_INCOMING_QUERY,
    addresses.HTTP_INCOMING_GRAPHQL_RESOLVER,
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
        attributes: {},
      }),
    }
    const wafContextWrapper = new WAFContextWrapper(ddwafContext, 1000, '1.14.0', '1.8.0', knownAddresses)

    const payload = {
      [addresses.HTTP_INCOMING_QUERY]: { key: 'value' },
    }

    wafContextWrapper.run(payload)
    wafContextWrapper.run(payload)

    sinon.assert.calledOnceWithExactly(ddwafContext.run, payload, 1000)
    sinon.assert.calledOnce(Reporter.reportMetrics)
  })

  it('Should send HTTP_INCOMING_QUERY twice if waf run fails', () => {
    const ddwafContext = {
      run: sinon.stub().throws(new Error('test')),
    }
    const wafContextWrapper = new WAFContextWrapper(ddwafContext, 1000, '1.14.0', '1.8.0', knownAddresses)

    const payload = {
      [addresses.HTTP_INCOMING_QUERY]: { key: 'value' },
    }

    wafContextWrapper.run(payload)
    wafContextWrapper.run(payload)

    sinon.assert.calledTwice(ddwafContext.run)
    sinon.assert.calledWithExactly(ddwafContext.run, payload, 1000)

    const firstCall = Reporter.reportMetrics.getCall(0).args[0]
    assert.strictEqual(firstCall.errorCode, -127)

    const secondCall = Reporter.reportMetrics.getCall(1).args[0]
    assert.strictEqual(secondCall.errorCode, -127)
  })

  it('Should deduplicate query data without dropping other addresses', () => {
    const ddwafContext = {
      run: sinon.stub().returns({
        events: {},
        attributes: {},
      }),
    }
    const wafContextWrapper = new WAFContextWrapper(ddwafContext, 1000, '1.14.0', '1.8.0', knownAddresses)

    const payload = {
      [addresses.HTTP_INCOMING_QUERY]: { key: 'value' },
      [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: { anotherKey: 'anotherValue' },
    }

    wafContextWrapper.run(payload)
    wafContextWrapper.run(payload)

    sinon.assert.calledTwice(ddwafContext.run)
    sinon.assert.calledWithExactly(ddwafContext.run.firstCall, payload, 1000)
    sinon.assert.calledWithExactly(ddwafContext.run.secondCall, {
      [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: {
        anotherKey: 'anotherValue',
      },
    }, 1000)
    sinon.assert.calledTwice(Reporter.reportMetrics)
  })

  it('Should ignore run without known addresses', () => {
    const ddwafContext = {
      run: sinon.stub(),
    }
    const wafContextWrapper = new WAFContextWrapper(ddwafContext, 1000, '1.14.0', '1.8.0', knownAddresses)

    const payload = {
      'requestData-unknown-address': { key: 'value' },
      'subcontextData-unknown-address': { key: 'value' },
    }

    wafContextWrapper.run(payload)

    sinon.assert.notCalled(ddwafContext.run)
  })

  it('should publish the payload in the dc channel', () => {
    const ddwafContext = {
      run: sinon.stub().returns([]),
    }
    const wafContextWrapper = new WAFContextWrapper(ddwafContext, 1000, '1.14.0', '1.8.0', knownAddresses)
    const payload = {
      [addresses.HTTP_INCOMING_QUERY]: { key: 'value' },
      [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: { anotherKey: 'anotherValue' },
    }
    const finishedCallback = sinon.stub()

    wafRunFinished.subscribe(finishedCallback)
    wafContextWrapper.run(payload)
    wafRunFinished.unsubscribe(finishedCallback)

    sinon.assert.calledOnceWithMatch(finishedCallback, { payload })
  })

  it('should report error code when the waf run fails', () => {
    const ddwafContext = {
      run: sinon.stub().returns({ errorCode: -2 }),
    }

    const wafContextWrapper = new WAFContextWrapper(ddwafContext, 1000, '1.14.0', '1.8.0', knownAddresses)

    const payload = {
      [addresses.HTTP_INCOMING_QUERY]: { key: 'value' },
    }

    wafContextWrapper.run(payload)

    sinon.assert.calledOnce(Reporter.reportMetrics)
    const reportedMetrics = Reporter.reportMetrics.getCall(0).args[0]

    assertObjectContains(reportedMetrics, {
      rulesVersion: '1.8.0',
      wafVersion: '1.14.0',
      wafTimeout: false,
      blockTriggered: false,
      ruleTriggered: false,
      errorCode: -2,
      maxTruncatedString: null,
      maxTruncatedContainerSize: null,
      maxTruncatedContainerDepth: null,
    })
  })

  it('should report a finite durationExt when hrtime delta exceeds safe-integer range', () => {
    const ddwafContext = {
      run: sinon.stub().returns({
        events: {},
        attributes: {},
      }),
    }
    const wafContextWrapper = new WAFContextWrapper(ddwafContext, 1000, '1.14.0', '1.8.0', knownAddresses)

    const startNs = 0n
    const endNs = 1n << 60n // 2^60 ns -- past Number.MAX_SAFE_INTEGER (2^53)
    const hrtimeStub = sinon.stub(process.hrtime, 'bigint')
    hrtimeStub.onCall(0).returns(startNs)
    hrtimeStub.onCall(1).returns(endNs)

    wafContextWrapper.run({
      [addresses.HTTP_INCOMING_QUERY]: { key: 'value' },
    })

    sinon.assert.calledOnce(Reporter.reportMetrics)
    const reportedMetrics = Reporter.reportMetrics.getCall(0).args[0]

    assert.strictEqual(typeof reportedMetrics.durationExt, 'number')
    assert.strictEqual(Number.isFinite(reportedMetrics.durationExt), true)
    assert.strictEqual(reportedMetrics.durationExt, Number(endNs - startNs) / 1e3)
  })

  it('should report truncation metrics, blockTriggered, and ruleTriggered on successful waf run', () => {
    const ddwafContext = {
      run: sinon.stub().returns({
        events: [{ rule_matches: [] }],
        attributes: [],
        actions: {
          redirect_request: {
            status_code: 301,
          },
        },
        duration: 123456,
        timeout: false,
        metrics: {
          maxTruncatedString: 5000,
          maxTruncatedContainerSize: 300,
          maxTruncatedContainerDepth: 20,
        },
      }),
    }

    const wafContextWrapper = new WAFContextWrapper(ddwafContext, 1000, '1.14.0', '1.8.0', knownAddresses)

    const payload = {
      [addresses.HTTP_INCOMING_QUERY]: { key: 'value' },
    }

    wafContextWrapper.run(payload)

    sinon.assert.calledOnce(Reporter.reportMetrics)
    const reportedMetrics = Reporter.reportMetrics.getCall(0).args[0]

    assertObjectContains(reportedMetrics, {
      rulesVersion: '1.8.0',
      wafVersion: '1.14.0',
      wafTimeout: false,
      blockTriggered: true,
      ruleTriggered: true,
      errorCode: null,
      maxTruncatedString: 5000,
      maxTruncatedContainerSize: 300,
      maxTruncatedContainerDepth: 20,
    })
  })

  describe('context and subcontext evaluation', () => {
    let parent, scoped, wrapper
    const requestData = { [addresses.HTTP_INCOMING_QUERY]: { key: 'value' } }
    const subcontextData = { [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: { field: 'value' } }

    beforeEach(() => {
      sinon.stub(process.hrtime, 'bigint').returns(0n)
      sinon.stub(Reporter, 'reportAttack')
      sinon.stub(Reporter, 'reportAttributes')
      scoped = {
        run: sinon.stub().returns({ duration: 2000, timeout: false, metrics: {} }),
        dispose: sinon.spy(function () { this.disposed = true }),
      }
      parent = {
        run: sinon.stub().returns({ duration: 1000, timeout: false, metrics: {} }),
        createSubcontext: sinon.stub().returns(scoped),
      }
      wrapper = new WAFContextWrapper(parent, 1000, '2.1.0', '1.8.0', knownAddresses)
    })

    it('evaluates request data on the main context', () => {
      wrapper.run(requestData)
      sinon.assert.calledOnceWithExactly(parent.run, requestData, 1000)
      sinon.assert.notCalled(parent.createSubcontext)
    })

    it('evaluates separate checks on independent subcontexts', () => {
      const nextOperation = { [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: { field: 'next' } }
      const nextContext = {
        run: sinon.stub().returns({ duration: 2000, timeout: false, metrics: {} }),
        dispose: sinon.spy(),
      }
      parent.createSubcontext.onSecondCall().returns(nextContext)

      const first = wrapper.createSubcontext()
      first.run(subcontextData)
      first.dispose()
      const second = wrapper.createSubcontext()
      second.run(nextOperation)
      second.dispose()

      sinon.assert.notCalled(parent.run)
      sinon.assert.calledTwice(parent.createSubcontext)
      sinon.assert.calledOnceWithExactly(scoped.run, subcontextData, 1000)
      sinon.assert.calledOnceWithExactly(nextContext.run, nextOperation, 1000)
      sinon.assert.calledOnce(scoped.dispose)
      sinon.assert.calledOnce(nextContext.dispose)
    })

    it('handles native subcontext creation failures without throwing', () => {
      parent.createSubcontext.throws(new Error('creation failed'))
      assert.strictEqual(wrapper.createSubcontext(), undefined)
    })

    it('does not create a subcontext after the parent is disposed', () => {
      parent.disposed = true
      assert.strictEqual(wrapper.createSubcontext(), undefined)
      sinon.assert.notCalled(parent.createSubcontext)
    })

    it('retains request and response data until the subcontext is disposed', () => {
      const scope = wrapper.createSubcontext()
      scope.run(subcontextData)
      scope.run(subcontextData)
      sinon.assert.calledOnce(parent.createSubcontext)
      sinon.assert.calledTwice(scoped.run)
      sinon.assert.notCalled(scoped.dispose)
      scope.dispose()
      scope.dispose()
      sinon.assert.calledOnce(scoped.dispose)
    })

    it('releases active scopes before disposing the parent request', () => {
      parent.dispose = sinon.spy()
      const scope = wrapper.createSubcontext()
      scope.run(subcontextData)
      wrapper.dispose()
      sinon.assert.calledOnce(parent.createSubcontext)
      sinon.assert.calledOnce(scoped.dispose)
      sinon.assert.callOrder(scoped.dispose, parent.dispose)
    })

    it('reports attributes without reporting an attack when no rule was triggered', () => {
      scoped.run.returns({ status: 'match', events: [], attributes: { tag: 'value' } })
      wrapper.createSubcontext().run(subcontextData)
      sinon.assert.notCalled(Reporter.reportAttack)
      sinon.assert.calledOnceWithMatch(Reporter.reportAttributes, { tag: 'value' })
    })
  })

  describe('blocked users', () => {
    const req = {}
    const userData = { [addresses.USER_ID]: 'blocked-user' }
    let native, wrapper, blocked

    beforeEach(() => {
      sinon.stub(Reporter, 'reportAttack')
      sinon.stub(Reporter, 'reportAttributes')
      blocked = {
        duration: 1000,
        keep: true,
        actions: { block_request: { status_code: 403 }, generate_stack: { stack_id: 'old' } },
        events: [{ rule_matches: [{ parameters: [{ address: addresses.USER_ID }] }] }],
        attributes: { original: 'attribute' },
      }
      native = { run: sinon.stub().returns(blocked) }
      wrapper = new WAFContextWrapper(native, 1000, '2.2.0', 'test', new Set([
        addresses.USER_ID, addresses.USER_LOGIN,
      ]), req)
      wrapper.run(userData)
      Reporter.reportAttack.resetHistory()
      Reporter.reportAttributes.resetHistory()
    })

    for (const data of [userData, { ...userData, [addresses.USER_LOGIN]: 'new-login' }]) {
      it(`returns the cached result without evaluating ${Object.keys(data).length} input addresses`, () => {
        const result = wrapper.run(data)

        assert.strictEqual(result, blocked)
        sinon.assert.calledOnce(native.run)
        sinon.assert.notCalled(Reporter.reportAttack)
        sinon.assert.notCalled(Reporter.reportAttributes)
      })
    }
  })

  describe('outgoing request and response correlation', () => {
    it('matches paired data without sharing it with another outgoing request', () => {
      const { DDWAF } = require('@datadog/native-appsec')
      const waf = new DDWAF({
        version: '2.2',
        rules: [{
          id: 'outgoing-redirect',
          name: 'Detect redirects from outgoing GET requests',
          tags: { type: 'ssrf', category: 'attack_attempt' },
          conditions: [
            {
              operator: 'exact_match',
              parameters: { inputs: [{ address: addresses.HTTP_OUTGOING_METHOD }], list: ['GET'] },
            },
            {
              operator: 'exact_match',
              parameters: { inputs: [{ address: addresses.HTTP_OUTGOING_RESPONSE_STATUS }], list: ['302'] },
            },
          ],
        }],
      }, 'outgoing-correlation', {})
      const wrapper = new WAFContextWrapper(waf.createContext(), 100000, DDWAF.version(), 'test', waf.knownAddresses)
      sinon.stub(Reporter, 'reportAttack')
      sinon.stub(Reporter, 'reportAttributes')
      const first = wrapper.createSubcontext()
      const second = wrapper.createSubcontext()
      const request = { [addresses.HTTP_OUTGOING_METHOD]: 'GET' }
      const response = { [addresses.HTTP_OUTGOING_RESPONSE_STATUS]: '302' }
      try {
        const requestResult = first.run(request)
        assert.strictEqual(requestResult.events?.length || 0, 0)
        const unrelatedResult = second.run(response)
        assert.strictEqual(unrelatedResult.events?.length || 0, 0)
        const pairedResult = first.run(response)
        assert.strictEqual(pairedResult.events.length, 1)
        assert.strictEqual(pairedResult.events[0].rule.id, 'outgoing-redirect')
        first.dispose()
        const nextHop = wrapper.createSubcontext()
        const nextResult = nextHop.run(response)
        assert.strictEqual(nextResult.events?.length || 0, 0)
      } finally {
        wrapper.dispose()
        waf.dispose()
      }
    })
  })

  describe('Disposal context check', () => {
    let log
    let ddwafContext
    let wafContextWrapper

    beforeEach(() => {
      log = {
        warn: sinon.stub(),
      }

      ddwafContext = {
        run: sinon.stub(),
      }

      const ProxiedWafContextWrapper = proxyquire('../../../src/appsec/waf/waf_context_wrapper', {
        '../../log': log,
      })

      wafContextWrapper = new ProxiedWafContextWrapper(ddwafContext, 1000, '1.14.0', '1.8.0', knownAddresses)
    })

    afterEach(() => {
      sinon.restore()
    })

    it('Should call run if context is not disposed', () => {
      ddwafContext.disposed = false

      const payload = {
        [addresses.HTTP_INCOMING_QUERY]: { key: 'value' },
      }

      wafContextWrapper.run(payload)

      sinon.assert.calledOnce(ddwafContext.run)
      sinon.assert.calledOnce(Reporter.reportMetrics)
    })

    it('Should not call run and log a warn if context is disposed', () => {
      ddwafContext.disposed = true

      const payload = {
        [addresses.HTTP_INCOMING_QUERY]: { key: 'value' },
      }

      wafContextWrapper.run(payload)

      sinon.assert.notCalled(ddwafContext.run)
      sinon.assert.calledOnceWithExactly(log.warn, '[ASM] Calling run on a disposed context')
      sinon.assert.notCalled(Reporter.reportRaspRuleSkipped)
      sinon.assert.notCalled(Reporter.reportMetrics)
    })

    it('Should call run with raspRule and call reportRaspRuleSkipped if context is disposed', () => {
      ddwafContext.disposed = true

      const payload = {
        [addresses.HTTP_INCOMING_QUERY]: { key: 'value' },
      }

      const raspRule = { type: 'rule-type' }
      wafContextWrapper.run(payload, raspRule)

      sinon.assert.notCalled(ddwafContext.run)
      sinon.assert.calledOnceWithExactly(log.warn, '[ASM] Calling run on a disposed context')
      sinon.assert.calledOnceWithExactly(Reporter.reportRaspRuleSkipped, raspRule, 'after-request')
      sinon.assert.notCalled(Reporter.reportMetrics)
    })
  })
})
