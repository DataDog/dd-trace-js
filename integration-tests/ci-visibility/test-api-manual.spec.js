'use strict'

const assert = require('assert')

const { exec } = require('child_process')
const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
  assertObjectContains,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const {
  TEST_MODULE,
  TEST_STATUS,
} = require('../../packages/dd-trace/src/plugins/util/test')

describe('test-api-manual', () => {
  let cwd, receiver, childProcess

  useSandbox([], true)

  before(async () => {
    cwd = sandboxCwd()
  })

  beforeEach(async function () {
    receiver = await new FakeCiVisIntake().start()
  })

  afterEach(async () => {
    childProcess.kill()
    await receiver.stop()
  })

  it('can use the manual api', (done) => {
    const receiverPromise = receiver.gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
      const events = payloads.flatMap(({ payload }) => payload.events)

      const testSessionEvent = events.find(event => event.type === 'test_session_end')
      const testModuleEvent = events.find(event => event.type === 'test_module_end')
      const testSuiteEvent = events.find(event => event.type === 'test_suite_end')

      assert.strictEqual(testSessionEvent.content.resource, 'test_session.fake-test-framework')
      assert.strictEqual(testModuleEvent.content.resource, 'test_module.fake-test-framework')
      assert.strictEqual(testSuiteEvent.content.resource, 'test_suite.ci-visibility/test-api-manual/test.fake.js')

      assert.strictEqual(testSessionEvent.content.meta[TEST_STATUS], 'fail')
      assert.strictEqual(testModuleEvent.content.meta[TEST_STATUS], 'fail')
      assert.strictEqual(testSuiteEvent.content.meta[TEST_STATUS], 'fail')
      assert.strictEqual(testModuleEvent.content.meta['test.session.custom.tag'], 'custom.session.value')
      assert.strictEqual(testSuiteEvent.content.meta['test.suite.custom.tag'], 'custom.suite.value')

      const testEvents = events.filter(event => event.type === 'test')
      assertObjectContains(testEvents.map(test => test.content.resource), [
        'ci-visibility/test-api-manual/test.fake.js.second test will fail',
        'ci-visibility/test-api-manual/test.fake.js.first test will pass',
        'ci-visibility/test-api-manual/test.fake.js.async test will pass',
        'ci-visibility/test-api-manual/test.fake.js.integration test',
      ])

      assertObjectContains(testEvents.map(test => test.content.meta[TEST_STATUS]), [
        'fail',
        'pass',
        'pass',
        'pass',
      ])

      for (const testEvent of testEvents) {
        assert.strictEqual(
          testEvent.content.test_suite_id.toString(),
          testSuiteEvent.content.test_suite_id.toString()
        )
        assert.strictEqual(
          testEvent.content.test_session_id.toString(),
          testSuiteEvent.content.test_session_id.toString()
        )
        assert.strictEqual(testEvent.content.meta[TEST_MODULE], 'test-api-manual')
      }

      const passedTest = testEvents.find(
        test => test.content.resource === 'ci-visibility/test-api-manual/test.fake.js.first test will pass'
      )
      assert.strictEqual(passedTest.content.meta['test.custom.tag'], 'custom.value')

      const sessionCustomSpan = events.find(
        event => event.type === 'span' && event.content.resource === 'session.custom.span'
      )
      const suiteCustomSpan = events.find(
        event => event.type === 'span' && event.content.resource === 'suite.custom.span'
      )
      const customSpan = events.find(event => event.type === 'span' && event.content.resource === 'custom.span')
      const integrationTest = testEvents.find(
        test => test.content.resource === 'ci-visibility/test-api-manual/test.fake.js.integration test'
      )

      assert.strictEqual(
        sessionCustomSpan.content.parent_id.toString(),
        testModuleEvent.content.test_module_id.toString()
      )
      assert.strictEqual(suiteCustomSpan.content.parent_id.toString(), testSuiteEvent.content.test_suite_id.toString())
      assert.strictEqual(customSpan.content.parent_id.toString(), integrationTest.content.span_id.toString())
    }).catch(done)

    childProcess = exec(
      'node --require ./ci-visibility/test-api-manual/setup-fake-test-framework.js ' +
      '--require ./ci-visibility/test-api-manual/test.fake.js ./ci-visibility/test-api-manual/run-fake-test-framework',
      {
        cwd,
        env: getCiVisAgentlessConfig(receiver.port),
      }
    )
    childProcess.on('exit', () => {
      receiverPromise.then(() => done())
    })
  })

  it('does not report test spans if DD_CIVISIBILITY_MANUAL_API_ENABLED is set to false', (done) => {
    receiver.assertPayloadReceived(() => {
      const error = new Error('should not report spans')
      done(error)
    }, ({ url }) => url === '/api/v2/citestcycle').catch(() => {})

    childProcess = exec(
      'node --require ./ci-visibility/test-api-manual/setup-fake-test-framework.js ' +
      '--require ./ci-visibility/test-api-manual/test.fake.js ./ci-visibility/test-api-manual/run-fake-test-framework',
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          DD_CIVISIBILITY_MANUAL_API_ENABLED: 'false',
        },
      }
    )
    childProcess.on('exit', () => {
      done()
    })
  })
})
