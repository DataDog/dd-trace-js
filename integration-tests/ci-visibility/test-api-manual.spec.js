'use strict'

const assert = require('assert')

const { exec } = require('child_process')
const { once } = require('node:events')
const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
  assertObjectContains,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const {
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

      const passedTest = testEvents.find(
        test => test.content.resource === 'ci-visibility/test-api-manual/test.fake.js.first test will pass'
      )
      assert.strictEqual(passedTest.content.meta['test.custom.tag'], 'custom.value')

      const customSpan = events.find(event => event.type === 'span')
      assert.strictEqual(customSpan.content.resource, 'custom.span')
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

  it('restores the active context after nested manual tests finish', async () => {
    childProcess = exec(
      'node --require ./ci-visibility/test-api-manual/setup-fake-test-framework.js ' +
      '--require ./ci-visibility/test-api-manual/context-restoration.fake.js ' +
      './ci-visibility/test-api-manual/run-fake-test-framework.js',
      {
        cwd,
        env: getCiVisAgentlessConfig(receiver.port),
      }
    )

    const eventsPromise = receiver.gatherPayloadsUntilChildExit(
      childProcess,
      ({ url }) => url === '/api/v2/citestcycle',
      (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const testEvents = events.filter(event => event.type === 'test')

        assertObjectContains(testEvents.map(test => test.content.resource), [
          'ci-visibility/test-api-manual/context-restoration.fake.js.nested manual test',
          'ci-visibility/test-api-manual/context-restoration.fake.js.restores the previous active span',
        ])
      }
    )
    const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])

    assert.strictEqual(exitCode, 0)
  })
})
