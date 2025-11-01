'use strict'

const { exec, execSync } = require('child_process')
const { once } = require('events')

const { assert } = require('chai')

const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const webAppServer = require('./web-app-server')
const { NODE_MAJOR } = require('../../version')

describe('test optimization automatic log submission', () => {
  let cwd, receiver, childProcess, webAppPort
  let testOutput = ''

  useSandbox([
    'mocha',
    '@cucumber/cucumber',
    'jest',
    'winston',
    'chai@4',
    '@playwright/test'
  ], true)

  before(done => {
    cwd = sandboxCwd()
    const { NODE_OPTIONS, ...restOfEnv } = process.env
    // Install chromium (configured in integration-tests/playwright.config.js)
    // *Be advised*: this means that we'll only be using chromium for this test suite
    execSync('npx playwright install chromium', { cwd, env: restOfEnv, stdio: 'inherit' })
    webAppServer.listen(0, () => {
      webAppPort = webAppServer.address().port
      done()
    })
  })

  after(async () => {
    await new Promise(resolve => webAppServer.close(resolve))
  })

  beforeEach(async function () {
    receiver = await new FakeCiVisIntake().start()
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
    },
    {
      name: 'playwright',
      command: './node_modules/.bin/playwright test -c playwright.config.js',
      getExtraEnvVars: () => ({
        PW_BASE_URL: `http://localhost:${webAppPort}`,
        TEST_DIR: 'ci-visibility/automatic-log-submission-playwright',
        DD_TRACE_DEBUG: 1
      })
    }
  ]

  testFrameworks.forEach(({ name, command, getExtraEnvVars = () => ({}) }) => {
    if ((NODE_MAJOR === 18 || NODE_MAJOR === 23) && name === 'cucumber') return

    context(`with ${name}`, () => {
      it('can automatically submit logs', async () => {
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
              DD_SERVICE: 'my-service',
              ...getExtraEnvVars()
            },
            stdio: 'pipe'
          }
        )
        childProcess.stdout.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.stderr.on('data', (chunk) => {
          testOutput += chunk.toString()
        })

        await Promise.all([
          once(childProcess, 'exit'),
          once(childProcess.stdout, 'end'),
          once(childProcess.stderr, 'end'),
          logsPromise,
          eventsPromise
        ])

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
      })

      it('does not submit logs when DD_AGENTLESS_LOG_SUBMISSION_ENABLED is not set', async () => {
        childProcess = exec(command,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              DD_AGENTLESS_LOG_SUBMISSION_URL: `http://localhost:${receiver.port}`,
              DD_SERVICE: 'my-service',
              ...getExtraEnvVars()
            },
            stdio: 'pipe'
          }
        )
        childProcess.stdout.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.stderr.on('data', (chunk) => {
          testOutput += chunk.toString()
        })

        let hasReceivedEvents = false

        const logsPromise = receiver.assertPayloadReceived(() => {
          hasReceivedEvents = true
        }, ({ url }) => url.endsWith('/api/v2/logs'), 5000).catch(() => {})

        await Promise.all([
          once(childProcess, 'exit'),
          once(childProcess.stdout, 'end'),
          once(childProcess.stderr, 'end'),
          logsPromise,
        ])

        assert.include(testOutput, 'Hello simple log!')
        assert.include(testOutput, 'span_id')
        assert.isFalse(hasReceivedEvents)
      })

      it('does not submit logs when DD_AGENTLESS_LOG_SUBMISSION_ENABLED is set but DD_API_KEY is not', async () => {
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
              DD_API_KEY: '',
              ...getExtraEnvVars()
            },
            stdio: 'pipe'
          }
        )

        childProcess.stdout.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.stderr.on('data', (chunk) => {
          testOutput += chunk.toString()
        })

        await Promise.all([
          once(childProcess, 'exit'),
          once(childProcess.stdout, 'end'),
          once(childProcess.stderr, 'end'),
        ])

        assert.include(testOutput, 'Hello simple log!')
        assert.include(testOutput, 'no automatic log submission will be performed')
      })
    })
  })
})
