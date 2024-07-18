'use strict'

const { exec } = require('child_process')

const getPort = require('get-port')
const { assert } = require('chai')

const {
  createSandbox,
  getCiVisAgentlessConfig
} = require('./helpers')
const { FakeCiVisIntake } = require('./ci-visibility-intake')
const webAppServer = require('./ci-visibility/web-app-server')
const {
  TEST_STATUS
} = require('../packages/dd-trace/src/plugins/util/test')

describe('test-api-manual', () => {
  let sandbox, cwd, receiver, childProcess, webAppPort

  before(async () => {
    sandbox = await createSandbox([], true)
    cwd = sandbox.folder
    webAppPort = await getPort()
    webAppServer.listen(webAppPort)
  })

  after(async () => {
    await sandbox.remove()
    await new Promise(resolve => webAppServer.close(resolve))
  })

  beforeEach(async function () {
    const port = await getPort()
    receiver = await new FakeCiVisIntake(port).start()
  })

  afterEach(async () => {
    childProcess.kill()
    await receiver.stop()
  })

  it('can use the manual api', (done) => {
    const receiverPromise = receiver.gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
      const events = payloads.flatMap(({ payload }) => payload.events)

      const testEvents = events.filter(event => event.type === 'test')
      assert.includeMembers(testEvents.map(test => test.content.resource), [
        'ci-visibility/test-api-manual/test.fake.js.second test will fail',
        'ci-visibility/test-api-manual/test.fake.js.first test will pass',
        'ci-visibility/test-api-manual/test.fake.js.async test will pass',
        'ci-visibility/test-api-manual/test.fake.js.integration test'
      ])

      assert.includeMembers(testEvents.map(test => test.content.meta[TEST_STATUS]), [
        'pass',
        'pass',
        'pass',
        'fail'
      ])

      const passedTest = testEvents.find(
        test => test.content.resource === 'ci-visibility/test-api-manual/test.fake.js.first test will pass'
      )
      assert.propertyVal(passedTest.content.meta, 'test.custom.tag', 'custom.value')

      const customSpan = events.find(event => event.type === 'span')
      assert.propertyVal(customSpan.content, 'resource', 'custom.span')
    }).catch(done)

    childProcess = exec(
      'node --require ./ci-visibility/test-api-manual/setup-fake-test-framework.js ' +
      '--require ./ci-visibility/test-api-manual/test.fake.js ./ci-visibility/test-api-manual/run-fake-test-framework',
      {
        cwd,
        env: { ...getCiVisAgentlessConfig(receiver.port), DD_CIVISIBILITY_MANUAL_API_ENABLED: '1' },
        stdio: 'pipe'
      }
    )
    childProcess.on('exit', () => {
      receiverPromise.then(() => done())
    })
  })

  it('does not report test spans if DD_CIVISIBILITY_MANUAL_API_ENABLED is not set', (done) => {
    receiver.assertPayloadReceived(() => {
      const error = new Error('should not report spans')
      done(error)
    }, ({ url }) => url === '/api/v2/citestcycle').catch(() => {})

    childProcess = exec(
      'node --require ./ci-visibility/test-api-manual/setup-fake-test-framework.js ' +
      '--require ./ci-visibility/test-api-manual/test.fake.js ./ci-visibility/test-api-manual/run-fake-test-framework',
      {
        cwd,
        env: getCiVisAgentlessConfig(receiver.port),
        stdio: 'pipe'
      }
    )
    childProcess.on('exit', () => {
      done()
    })
  })
})
