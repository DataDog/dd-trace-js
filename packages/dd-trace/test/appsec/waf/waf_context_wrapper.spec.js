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
      persistent: {
        [addresses.HTTP_INCOMING_QUERY]: { key: 'value' },
      },
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
      persistent: {
        [addresses.HTTP_INCOMING_QUERY]: { key: 'value' },
      },
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

  it('Should send ephemeral addresses every time', () => {
    const ddwafContext = {
      run: sinon.stub().returns({
        events: {},
        attributes: {},
      }),
    }
    const wafContextWrapper = new WAFContextWrapper(ddwafContext, 1000, '1.14.0', '1.8.0', knownAddresses)

    const payload = {
      persistent: {
        [addresses.HTTP_INCOMING_QUERY]: { key: 'value' },
      },
      ephemeral: {
        [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: { anotherKey: 'anotherValue' },
      },
    }

    wafContextWrapper.run(payload)
    wafContextWrapper.run(payload)

    sinon.assert.calledTwice(ddwafContext.run)
    sinon.assert.calledWithExactly(ddwafContext.run.firstCall, payload, 1000)
    sinon.assert.calledWithExactly(ddwafContext.run.secondCall, {
      ephemeral: {
        [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: {
          anotherKey: 'anotherValue',
        },
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
      persistent: {
        'persistent-unknown-address': { key: 'value' },
      },
      ephemeral: {
        'ephemeral-unknown-address': { key: 'value' },
      },
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
      persistent: {
        [addresses.HTTP_INCOMING_QUERY]: { key: 'value' },
      },
      ephemeral: {
        [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: { anotherKey: 'anotherValue' },
      },
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
      persistent: {
        [addresses.HTTP_INCOMING_QUERY]: { key: 'value' },
      },
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
      persistent: {
        [addresses.HTTP_INCOMING_QUERY]: { key: 'value' },
      },
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
      persistent: {
        [addresses.HTTP_INCOMING_QUERY]: { key: 'value' },
      },
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

  describe('native-appsec 12 contexts', () => {
    let parent, scoped, wrapper, clock
    const persistent = { [addresses.HTTP_INCOMING_QUERY]: { key: 'value' } }
    const ephemeral = { [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: { field: 'value' } }

    beforeEach(() => {
      clock = sinon.stub(process.hrtime, 'bigint').returns(0n)
      sinon.stub(Reporter, 'reportAttack')
      sinon.stub(Reporter, 'reportAttributes')
      scoped = {
        run: sinon.stub().returns({ duration: 2000, timeout: false, metrics: {} }),
        dispose: sinon.spy(),
      }
      parent = {
        run: sinon.stub().returns({ duration: 1000, timeout: false, metrics: {} }),
        createSubcontext: sinon.stub().returns(scoped),
      }
      wrapper = new WAFContextWrapper(parent, 1000, '2.1.0', '1.8.0', knownAddresses)
    })

    it('passes persistent addresses directly without a subcontext', () => {
      wrapper.run({ persistent })
      sinon.assert.calledOnceWithExactly(parent.run, persistent, 1000)
      sinon.assert.notCalled(parent.createSubcontext)
    })

    it('uses a new subcontext for each scoped evaluation and disposes it', () => {
      wrapper.run({ ephemeral })
      wrapper.run({ ephemeral })
      sinon.assert.notCalled(parent.run)
      sinon.assert.calledTwice(parent.createSubcontext)
      sinon.assert.calledTwice(scoped.dispose)
      sinon.assert.alwaysCalledWithExactly(scoped.run, ephemeral, 1000)
    })

    it('combines results and spends the remaining timeout on scoped data', () => {
      clock.onCall(0).returns(0n)
      clock.onCall(1).returns(250000n)
      clock.onCall(2).returns(300000n)
      parent.run.returns({
        status: 'match',
        events: [{ rule_matches: [] }],
        attributes: { first: 1 },
        keep: true,
        duration: 1000,
        metrics: { maxTruncatedString: 8000 },
      })
      scoped.run.returns({
        attributes: { second: 2 },
        duration: 2000,
        timeout: false,
        keep: false,
        metrics: { maxTruncatedString: 5000 },
      })

      const result = wrapper.run({ persistent, ephemeral })

      sinon.assert.calledOnceWithExactly(parent.run, persistent, 1000)
      sinon.assert.calledOnceWithExactly(scoped.run, ephemeral, 750)
      sinon.assert.calledOnce(scoped.dispose)
      assert.deepStrictEqual(result.attributes, { first: 1, second: 2 })
      assert.strictEqual(result.events.length, 1)
      assert.strictEqual(result.duration, 3000)
      assert.strictEqual(result.keep, true)
      assert.strictEqual(result.metrics.maxTruncatedString, 8000)
      const metrics = Reporter.reportMetrics.firstCall.args[0]
      assert.strictEqual(metrics.duration, 3)
      sinon.assert.calledOnce(Reporter.reportAttack)
    })

    for (const result of [
      { timeout: true },
      { errorCode: -2 },
      { actions: { block_request: { status_code: 403 } } },
    ]) {
      it(`stops after a decisive parent result: ${JSON.stringify(result)}`, () => {
        parent.run.returns(result)
        wrapper.run({ persistent, ephemeral })
        sinon.assert.notCalled(parent.createSubcontext)
      })
    }

    it('does not grant a second timeout when the shared budget is exhausted', () => {
      clock.onCall(1).returns(1000000n)
      const result = wrapper.run({ persistent, ephemeral })
      assert.strictEqual(result.timeout, true)
      sinon.assert.notCalled(scoped.run)
      sinon.assert.calledOnce(scoped.dispose)
    })

    for (const throws of [false, true]) {
      it(`disposes the scoped context on ${throws ? 'a thrown exception' : 'a native error'}`, () => {
        if (throws) scoped.run.throws(new Error('scoped evaluation failed'))
        else scoped.run.returns({ errorCode: -2 })
        wrapper.run({ ephemeral })
        sinon.assert.calledOnce(scoped.dispose)
        assert.strictEqual(Reporter.reportMetrics.firstCall.args[0].errorCode, throws ? -127 : -2)
      })
    }

    it('preserves parent events when the scoped evaluation fails', () => {
      parent.run.returns({ events: [{ rule_matches: [] }], duration: 1000 })
      scoped.run.returns({ errorCode: -2 })
      const result = wrapper.run({ persistent, ephemeral })
      assert.strictEqual(result.events.length, 1)
      sinon.assert.calledOnce(Reporter.reportAttack)
      assert.strictEqual(Reporter.reportMetrics.firstCall.args[0].errorCode, -2)
    })

    it('preserves parent output when subcontext creation throws', () => {
      parent.run.returns({ attributes: { tag: 'ordinary' }, duration: 1000 })
      parent.createSubcontext.throws(new Error('creation failed'))
      const result = wrapper.run({ persistent, ephemeral })
      assert.deepStrictEqual(result.attributes, { tag: 'ordinary' })
      assert.strictEqual(Reporter.reportMetrics.firstCall.args[0].errorCode, -127)
      sinon.assert.notCalled(scoped.dispose)
    })

    it('does not treat an attributes-only match as a rule event', () => {
      scoped.run.returns({ status: 'match', events: [], attributes: { tag: 'value' } })
      wrapper.run({ ephemeral })
      sinon.assert.notCalled(Reporter.reportAttack)
      sinon.assert.calledOnceWithMatch(Reporter.reportAttributes, { tag: 'value' })
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
        persistent: {
          [addresses.HTTP_INCOMING_QUERY]: { key: 'value' },
        },
      }

      wafContextWrapper.run(payload)

      sinon.assert.calledOnce(ddwafContext.run)
      sinon.assert.calledOnce(Reporter.reportMetrics)
    })

    it('Should not call run and log a warn if context is disposed', () => {
      ddwafContext.disposed = true

      const payload = {
        persistent: {
          [addresses.HTTP_INCOMING_QUERY]: { key: 'value' },
        },
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
        persistent: {
          [addresses.HTTP_INCOMING_QUERY]: { key: 'value' },
        },
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
