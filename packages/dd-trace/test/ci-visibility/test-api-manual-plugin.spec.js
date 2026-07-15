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
    _store: legacyStorage.getHandle(),
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
    let outerTestSpan
    let innerTestSpan
    sinon.stub(plugin, 'startTestSpan').callsFake(() => {
      const testSpan = createTestSpan()
      if (outerTestSpan) {
        innerTestSpan = testSpan
      } else {
        outerTestSpan = testSpan
      }
      return testSpan
    })

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

  it('restores an empty previous store', () => {
    const testSpan = createTestSpan()
    testSpan._store = undefined
    sinon.stub(plugin, 'startTestSpan').returns(testSpan)

    testStartCh.publish({ testName: 'root test', testSuite: __filename })
    assert.strictEqual(legacyStorage.getStore().span, testSpan)

    testFinishCh.publish({ status: 'pass' })
    assert.strictEqual(legacyStorage.getStore(), undefined)
  })
})
