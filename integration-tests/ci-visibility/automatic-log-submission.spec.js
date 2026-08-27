'use strict'

const assert = require('assert')
const { exec } = require('child_process')
const { once } = require('events')
const http = require('http')

const {
  sandboxCwd,
  useSandbox,
  installPlaywrightChromium,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig,
  assertObjectContains,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { NODE_MAJOR } = require('../../version')
const { getLatestPlaywrightSpecifier } = require('../playwright/versions')
const webAppServer = require('./web-app-server')

const isLatestCucumberSupported = NODE_MAJOR === 22 || NODE_MAJOR === 24 || NODE_MAJOR >= 26
const playwrightDependency = `@playwright/test@${getLatestPlaywrightSpecifier()}`
const vitestDependency = NODE_MAJOR <= 18 ? 'vitest@3.2.6' : 'vitest'

describe('test optimization automatic log submission', () => {
  let cwd, receiver, childProcess, webAppPort
  let testOutput = ''

  useSandbox([
    'mocha',
    ...(isLatestCucumberSupported ? ['@cucumber/cucumber'] : []),
    'bunyan',
    'jest',
    'pino',
    vitestDependency,
    'winston',
    playwrightDependency,
  ], true)

  before(async () => {
    cwd = sandboxCwd()
    installPlaywrightChromium(cwd)
    await new Promise((resolve, reject) => {
      webAppServer.listen(0, () => {
        const address = webAppServer.address()
        if (!address || typeof address === 'string') {
          reject(new Error('Failed to determine web app server port'))
          return
        }
        webAppPort = address.port
        resolve()
      })
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
      command: './node_modules/.bin/mocha ./ci-visibility/automatic-log-submission/automatic-log-submission-test.js',
      loggerNames: ['winston', 'bunyan', 'pino'],
    },
    {
      name: 'vitest',
      command: './node_modules/.bin/vitest run --config ./ci-visibility/automatic-log-submission-vitest/config.mjs',
      loggerNames: ['winston', 'bunyan', 'pino'],
      getExtraEnvVars: () => ({
        NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
      }),
    },
    {
      name: 'jest',
      command: 'node ./node_modules/jest/bin/jest --config ./ci-visibility/automatic-log-submission/config-jest.js',
    },
    {
      name: 'cucumber',
      command: './node_modules/.bin/cucumber-js ci-visibility/automatic-log-submission-cucumber/*.feature',
      loggerNames: ['winston', 'bunyan', 'pino'],
    },
    {
      name: 'playwright',
      command: './node_modules/.bin/playwright test -c playwright.config.js',
      loggerNames: ['winston', 'bunyan'],
      getExtraEnvVars: () => ({
        PW_BASE_URL: `http://localhost:${webAppPort}`,
        TEST_DIR: 'ci-visibility/automatic-log-submission-playwright',
        DD_TRACE_DEBUG: '1',
      }),
    },
  ]

  const loggers = {
    bunyan: { level: 30, messageKey: 'msg' },
    pino: { level: 30, messageKey: 'msg' },
    winston: { level: 'info', messageKey: 'message' },
  }

  testFrameworks.flatMap(framework => {
    return (framework.loggerNames || ['winston']).map(loggerName => ({ ...framework, loggerName }))
  }).forEach(({ name, command, getExtraEnvVars = () => ({}), loggerName }) => {
    if (!isLatestCucumberSupported && name === 'cucumber') return

    const { level: expectedLevel, messageKey } = loggers[loggerName]

    context(`with ${loggerName} and ${name}`, () => {
      it('can automatically submit logs', async () => {
        let logIds = {}
        let testIds = {}

        const logsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.includes('/api/v2/logs'), payloads => {
            payloads.forEach(({ headers }) => {
              assert.equal(headers['dd-api-key'], '1')
              assert.equal(headers['content-type'], 'application/json')
            })
            assert.equal(payloads.length, 1)
            const logMessages = payloads.flatMap(({ logMessage }) => logMessage)
            const [url] = payloads.flatMap(({ url }) => url)

            assert.equal(url, `/api/v2/logs?ddsource=${loggerName}&service=my-service`)
            assert.equal(logMessages.length, 2)

            logMessages.forEach(({ dd, level }) => {
              assert.equal(level, expectedLevel)
              assert.equal(dd.service, 'my-service')
              assert.deepStrictEqual(['service', 'span_id', 'trace_id'], Object.keys(dd).sort())
            })

            assertObjectContains(logMessages.map(logMessage => logMessage[messageKey]), [
              'Hello simple log!',
              'sum function being called',
            ])
            if (loggerName === 'winston' && (name === 'mocha' || name === 'jest')) {
              const circularLog = logMessages.find(({ message }) => message === 'Hello simple log!')
              assert.equal(circularLog.circular.self, '[Circular]')
            }

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

        await Promise.all([
          once(childProcess, 'exit'),
          once(childProcess.stdout, 'end'),
          once(childProcess.stderr, 'end'),
          logsPromise,
          eventsPromise,
        ])

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

  context('with bunyan and multiple playwright test groups', () => {
    it('waits for pending requests only when the worker exits', async () => {
      const logMessages = []
      let firstLogResponse
      let firstLogRequestAborted = false
      let waitingTestResponse

      const respond = (response) => {
        if (response.destroyed || response.writableEnded) return

        response.writeHead(200)
        response.end('OK')
      }
      const logsServer = http.createServer((request, response) => {
        if (request.method === 'GET' && request.url === '/wait-for-first-log') {
          if (firstLogResponse) respond(response)
          else waitingTestResponse = () => respond(response)
          return
        }
        if (request.method === 'GET' && request.url === '/second-group-started') {
          firstLogResponse()
          respond(response)
          return
        }
        if (request.method !== 'POST' || !request.url.startsWith('/api/v2/logs')) {
          response.writeHead(404)
          response.end()
          return
        }

        let body = ''
        request.setEncoding('utf8')
        request.on('data', chunk => {
          body += chunk
        })
        request.on('end', () => {
          logMessages.push(...JSON.parse(body))
          if (firstLogResponse) {
            respond(response)
            return
          }

          response.once('close', () => {
            if (!response.writableEnded) firstLogRequestAborted = true
          })
          firstLogResponse = () => respond(response)
          waitingTestResponse?.()
        })
      })
      await new Promise((resolve, reject) => {
        logsServer.once('error', reject)
        logsServer.listen(0, resolve)
      })

      try {
        const { port } = logsServer.address()
        childProcess = exec('./node_modules/.bin/playwright test -c playwright.config.js', {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            DD_AGENTLESS_LOG_SUBMISSION_ENABLED: '1',
            DD_AGENTLESS_LOG_SUBMISSION_URL: `http://localhost:${port}`,
            DD_API_KEY: '1',
            DD_SERVICE: 'my-service',
            LOG_SUBMISSION_CONTROL_URL: `http://localhost:${port}`,
            PLAYWRIGHT_WORKERS: '1',
            TEST_DIR: 'ci-visibility/automatic-log-submission-playwright-multiple-groups',
            TEST_LOGGER: 'bunyan',
          },
        })
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
      } finally {
        firstLogResponse?.()
        waitingTestResponse?.()
        await new Promise(resolve => logsServer.close(resolve))
      }

      assert.equal(childProcess.exitCode, 0, testOutput)
      assert.equal(firstLogRequestAborted, false)
      assert.deepStrictEqual(logMessages.map(({ msg }) => msg).sort(), [
        'first group log',
        'second group log',
      ])
    })
  })
})
