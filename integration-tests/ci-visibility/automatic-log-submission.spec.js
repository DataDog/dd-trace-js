'use strict'

const assert = require('assert')
const { exec } = require('child_process')
const { once } = require('events')

const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig,
  assertObjectContains,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { NODE_MAJOR } = require('../../version')
const { getLatestPlaywrightSpecifier } = require('../playwright/versions')

const isLatestCucumberSupported = NODE_MAJOR === 22 || NODE_MAJOR === 24 || NODE_MAJOR >= 26
const playwrightDependency = `@playwright/test@${getLatestPlaywrightSpecifier()}`

describe('test optimization automatic log submission', () => {
  let cwd, receiver, childProcess
  let testOutput = ''

  useSandbox([
    'mocha',
    ...(isLatestCucumberSupported ? ['@cucumber/cucumber'] : []),
    'bunyan',
    'jest',
    'pino',
    'winston',
    playwrightDependency,
  ], true)

  before(() => {
    cwd = sandboxCwd()
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
      command: './node_modules/.bin/mocha ./ci-visibility/automatic-log-submission/automatic-log-submission-test.js',
    },
    {
      name: 'jest',
      command: 'node ./node_modules/jest/bin/jest --config ./ci-visibility/automatic-log-submission/config-jest.js',
    },
    {
      name: 'cucumber',
      command: './node_modules/.bin/cucumber-js ci-visibility/automatic-log-submission-cucumber/*.feature',
    },
    {
      name: 'playwright',
      command: './node_modules/.bin/playwright test -c playwright.config.js',
      getExtraEnvVars: () => ({
        TEST_DIR: 'ci-visibility/automatic-log-submission-playwright',
        DD_TRACE_DEBUG: '1',
      }),
    },
  ]

  const loggers = [
    { name: 'winston', level: 'info', messageKey: 'message' },
    { name: 'pino', level: 30, messageKey: 'msg' },
    { name: 'bunyan', level: 30, messageKey: 'msg' },
  ]

  loggers.forEach(({ name: loggerName, level: expectedLevel, messageKey }) => {
    testFrameworks.forEach(({ name, command, getExtraEnvVars = () => ({}) }) => {
      if (!isLatestCucumberSupported && name === 'cucumber') return

      context(`with ${loggerName} and ${name}`, () => {
        it('can automatically submit logs', async () => {
          let logIds = {}
          let testIds = {}

          const logsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.includes('/api/v2/logs'), payloads => {
              payloads.forEach(({ headers }) => {
                assert.equal(headers['dd-api-key'], '1')
                if (loggerName !== 'winston') {
                  assert.equal(headers['content-type'], 'application/json')
                }
              })
              const logMessages = payloads.flatMap(({ logMessage }) => logMessage)
              const [url] = payloads.flatMap(({ url }) => url)

              assert.equal(url, `/api/v2/logs?ddsource=${loggerName}&service=my-service`)
              assert.equal(logMessages.length, 2)

              logMessages.forEach(({ dd, level }) => {
                assert.equal(level, expectedLevel)
                assert.equal(dd.service, 'my-service')
                assert.deepStrictEqual(['service', 'span_id', 'trace_id'], Object.keys(dd).sort())
                assert.match(dd.trace_id, /^\d+$/)
                assert.match(dd.span_id, /^\d+$/)
              })

              assertObjectContains(logMessages.map(logMessage => logMessage[messageKey]), [
                'Hello simple log!',
                'sum function being called',
              ])

              logIds = {
                logSpanId: logMessages[0].dd.span_id,
                logTraceId: logMessages[0].dd.trace_id,
              }
            })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const testEventContent = events.find(event => event.type === 'test').content

              testIds = {
                testSpanId: testEventContent.span_id.toString(),
                testTraceId: testEventContent.trace_id.toString(),
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
                TEST_LOGGER: loggerName,
                ...getExtraEnvVars(),
              },
            }
          )
          childProcess.stdout?.on('data', (chunk) => {
            testOutput += chunk.toString()
          })
          childProcess.stderr?.on('data', (chunk) => {
            testOutput += chunk.toString()
          })

          const [[exitCode]] = await Promise.all([
            once(childProcess, 'exit'),
            once(childProcess.stdout, 'end'),
            once(childProcess.stderr, 'end'),
            logsPromise,
            eventsPromise,
          ])

          // Guards the Playwright worker completion barrier: the worker process must not exit
          // until both trace export and pending log-submission requests have settled.
          assert.strictEqual(exitCode, 0)

          const { logSpanId, logTraceId } = logIds
          const { testSpanId, testTraceId } = testIds
          assert.match(testOutput, /Hello simple log!/)
          assert.match(testOutput, /sum function being called/)
          // cucumber has `cucumber.step`, and that's the active span, not the test.
          // logs are queried by trace id, so it should be OK
          if (name !== 'cucumber') {
            assert.match(testOutput, new RegExp(`"span_id":"${testSpanId}"`))
            assert.equal(logSpanId, testSpanId)
          }
          assert.match(testOutput, new RegExp(`"trace_id":"${testTraceId}"`))
          assert.equal(logTraceId, testTraceId)
        })

        if (name === 'jest' && loggerName !== 'winston') {
          it('waits for the final log request to complete before the worker exits', async () => {
            const releaseLogResponses = receiver.blockLogResponses()
            const logsPromise = receiver
              .gatherPayloadsMaxTimeout(({ url }) => url.includes('/api/v2/logs'), payloads => {
                assert.strictEqual(payloads.length, 1, testOutput)
                assert.strictEqual(payloads[0].logMessage.length, 2, testOutput)
              })

            childProcess = exec(command, {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                DD_AGENTLESS_LOG_SUBMISSION_ENABLED: '1',
                DD_AGENTLESS_LOG_SUBMISSION_URL: `http://localhost:${receiver.port}`,
                DD_API_KEY: '1',
                DD_SERVICE: 'my-service',
                TEST_JEST_WORKER_SHUTDOWN: '1',
                TEST_LOGGER: loggerName,
                ...getExtraEnvVars(),
              },
            })
            childProcess.stdout?.on('data', chunk => {
              testOutput += chunk.toString()
            })
            childProcess.stderr?.on('data', chunk => {
              testOutput += chunk.toString()
            })

            const exitPromise = once(childProcess, 'exit')
            await logsPromise

            assert.strictEqual(childProcess.exitCode, null, testOutput)
            releaseLogResponses()

            const [exitCode] = await exitPromise
            assert.strictEqual(exitCode, 0, testOutput)
          })
        }

        it('does not submit logs when DD_AGENTLESS_LOG_SUBMISSION_ENABLED is not set', async () => {
          childProcess = exec(command,
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                DD_AGENTLESS_LOG_SUBMISSION_URL: `http://localhost:${receiver.port}`,
                DD_SERVICE: 'my-service',
                TEST_LOGGER: loggerName,
                ...getExtraEnvVars(),
              },
            }
          )
          childProcess.stdout?.on('data', (chunk) => {
            testOutput += chunk.toString()
          })
          childProcess.stderr?.on('data', (chunk) => {
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

          assert.match(testOutput, /Hello simple log!/)
          assert.match(testOutput, /span_id/)
          assert.strictEqual(hasReceivedEvents, false)
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
                TEST_LOGGER: loggerName,
                ...getExtraEnvVars(),
              },
            }
          )

          childProcess.stdout?.on('data', (chunk) => {
            testOutput += chunk.toString()
          })
          childProcess.stderr?.on('data', (chunk) => {
            testOutput += chunk.toString()
          })

          await Promise.all([
            once(childProcess, 'exit'),
            once(childProcess.stdout, 'end'),
            once(childProcess.stderr, 'end'),
          ])

          assert.match(testOutput, /Hello simple log!/)
          assert.match(testOutput, /no automatic log submission will be performed/)
        })
      })
    })
  })
})
