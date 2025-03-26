'use strict'

const { exec } = require('child_process')

const { assert } = require('chai')
const getPort = require('get-port')

const {
  createSandbox,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig
} = require('./helpers')
const { FakeCiVisIntake } = require('./ci-visibility-intake')
const webAppServer = require('./ci-visibility/web-app-server')

describe('test visibility automatic log submission', () => {
  let sandbox, cwd, receiver, childProcess, webAppPort
  let testOutput = ''

  before(async () => {
    sandbox = await createSandbox([
      'mocha',
      '@cucumber/cucumber',
      'jest',
      'winston',
      'chai@4'
    ], true)
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
    testOutput = ''
    childProcess.kill()
    await receiver.stop()
  })

  const testFrameworks = [
    {
      name: 'mocha',
      command: 'mocha ./ci-visibility/automatic-log-submission/automatic-log-submission-test.js'
    },
    {
      name: 'jest',
      command: 'node ./node_modules/jest/bin/jest --config ./ci-visibility/automatic-log-submission/config-jest.js'
    },
    {
      name: 'cucumber',
      command: './node_modules/.bin/cucumber-js ci-visibility/automatic-log-submission-cucumber/*.feature'
    }
  ]

  testFrameworks.forEach(({ name, command }) => {
    context(`with ${name}`, () => {
      it('can automatically submit logs', (done) => {
        let logIds, testIds

        const logsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.includes('/api/v2/logs'), payloads => {
            payloads.forEach(({ headers }) => {
              assert.equal(headers['dd-api-key'], '1')
            })
            const logMessages = payloads.flatMap(({ logMessage }) => logMessage)
            const [url] = payloads.flatMap(({ url }) => url)

            assert.equal(url, '/api/v2/logs?ddsource=winston&service=my-service')
            assert.equal(logMessages.length, 2)

            logMessages.forEach(({ dd, level }) => {
              assert.equal(level, 'info')
              assert.equal(dd.service, 'my-service')
              assert.hasAllKeys(dd, ['trace_id', 'span_id', 'service'])
            })

            assert.includeMembers(logMessages.map(({ message }) => message), [
              'Hello simple log!',
              'sum function being called'
            ])

            logIds = {
              logSpanId: logMessages[0].dd.span_id,
              logTraceId: logMessages[0].dd.trace_id
            }
          })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testEventContent = events.find(event => event.type === 'test').content

            testIds = {
              testSpanId: testEventContent.span_id.toString(),
              testTraceId: testEventContent.trace_id.toString()
            }
          })

        childProcess = exec(command,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              DD_AGENTLESS_LOG_SUBMISSION_ENABLED: '1',
              DD_AGENTLESS_LOG_SUBMISSION_URL: `http://localhost:${receiver.port}`,
              DD_API_KEY: '1',
              DD_SERVICE: 'my-service'
            },
            stdio: 'pipe'
          }
        )
        childProcess.on('exit', () => {
          Promise.all([logsPromise, eventsPromise]).then(() => {
            const { logSpanId, logTraceId } = logIds
            const { testSpanId, testTraceId } = testIds
            assert.include(testOutput, 'Hello simple log!')
            assert.include(testOutput, 'sum function being called')
            // cucumber has `cucumber.step`, and that's the active span, not the test.
            // logs are queried by trace id, so it should be OK
            if (name !== 'cucumber') {
              assert.include(testOutput, `"span_id":"${testSpanId}"`)
              assert.equal(logSpanId, testSpanId)
            }
            assert.include(testOutput, `"trace_id":"${testTraceId}"`)
            assert.equal(logTraceId, testTraceId)
            done()
          }).catch(done)
        })

        childProcess.stdout.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.stderr.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
      })

      it('does not submit logs when DD_AGENTLESS_LOG_SUBMISSION_ENABLED is not set', (done) => {
        childProcess = exec(command,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              DD_AGENTLESS_LOG_SUBMISSION_URL: `http://localhost:${receiver.port}`,
              DD_SERVICE: 'my-service'
            },
            stdio: 'pipe'
          }
        )
        childProcess.on('exit', () => {
          assert.include(testOutput, 'Hello simple log!')
          assert.notInclude(testOutput, 'span_id')
          done()
        })

        childProcess.stdout.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.stderr.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
      })

      it('does not submit logs when DD_AGENTLESS_LOG_SUBMISSION_ENABLED is set but DD_API_KEY is not', (done) => {
        childProcess = exec(command,
          {
            cwd,
            env: {
              ...getCiVisEvpProxyConfig(receiver.port),
              DD_AGENTLESS_LOG_SUBMISSION_ENABLED: '1',
              DD_AGENTLESS_LOG_SUBMISSION_URL: `http://localhost:${receiver.port}`,
              DD_SERVICE: 'my-service',
              DD_TRACE_DEBUG: '1',
              DD_TRACE_LOG_LEVEL: 'warn',
              DD_API_KEY: ''
            },
            stdio: 'pipe'
          }
        )
        childProcess.on('exit', () => {
          assert.include(testOutput, 'Hello simple log!')
          assert.include(testOutput, 'no automatic log submission will be performed')
          done()
        })

        childProcess.stdout.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.stderr.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
      })
    })
  })
})
