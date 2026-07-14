'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const sinon = require('sinon')

const { storage } = require('../../../datadog-core')
const TestApiManualPlugin = require('../../src/ci-visibility/test-api-manual/test-api-manual-plugin')
const { TEST_STATUS } = require('../../src/plugins/util/test')

const legacyStorage = storage('legacy')
const testFinishCh = channel('dd-trace:ci:manual:test:finish')
const testStartCh = channel('dd-trace:ci:manual:test:start')

function createTestSpan () {
  const span = {
    context: () => ({
      _trace: {
        started: [span],
      },
    }),
    finish: sinon.spy(),
    setTag: sinon.spy(),
  }
  return span
}

describe('TestApiManualPlugin', () => {
  let plugin

  beforeEach(() => {
    plugin = new TestApiManualPlugin({}, {})
    plugin.configure({ enabled: true })
  })

  afterEach(() => {
    plugin.configure(false)
  })

  it('restores each previous store as nested tests finish', () => {
    const parentStore = { span: { name: 'parent' } }
    const outerTestSpan = createTestSpan()
    const innerTestSpan = createTestSpan()
    sinon.stub(plugin, 'startTestSpan')
      .onFirstCall().returns(outerTestSpan)
      .onSecondCall().returns(innerTestSpan)

    legacyStorage.run(parentStore, () => {
      testStartCh.publish({ testName: 'outer test', testSuite: __filename })
      const outerTestStore = legacyStorage.getStore()
      assert.strictEqual(outerTestStore.span, outerTestSpan)

      testStartCh.publish({ testName: 'inner test', testSuite: __filename })
      assert.strictEqual(legacyStorage.getStore().span, innerTestSpan)

      testFinishCh.publish({ status: 'pass' })
      assert.strictEqual(legacyStorage.getStore(), outerTestStore)

      testFinishCh.publish({ status: 'fail' })
      assert.strictEqual(legacyStorage.getStore(), parentStore)
    })

    sinon.assert.calledOnceWithExactly(innerTestSpan.setTag, TEST_STATUS, 'pass')
    sinon.assert.calledOnceWithExactly(outerTestSpan.setTag, TEST_STATUS, 'fail')
    sinon.assert.calledOnce(innerTestSpan.finish)
    sinon.assert.calledOnce(outerTestSpan.finish)
  })
})
