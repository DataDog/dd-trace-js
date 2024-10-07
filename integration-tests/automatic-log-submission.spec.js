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
    sandbox = await createSandbox(['mocha', 'jest', 'winston', 'chai@4'], true)
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
    }
  ]

  testFrameworks.forEach(({ name, command }) => {
    context(`with ${name}`, () => {
      it('can automatically submit logs', (done) => {
        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.includes('/api/v2/logs'), payloads => {
            const logMessages = payloads.flatMap(({ logMessage }) => logMessage)
            const [url] = payloads.flatMap(({ url }) => url)

            assert.equal(url, '/api/v2/logs?dd-api-key=1&ddsource=winston&service=my-service')
            assert.equal(logMessages.length, 1)
            const [{ dd, level, message }] = logMessages

            assert.equal(level, 'info')
            assert.equal(message, 'Hello simple log!')
            assert.equal(dd.service, 'my-service')
            assert.hasAllKeys(dd, ['trace_id', 'span_id', 'service'])
          }).catch(done)

        childProcess = exec(command,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              DD_AGENTLESS_LOG_SUBMISSION_ENABLED: '1',
              DD_CIVISIBILITY_AGENTLESS_LOGS_HOST: 'localhost',
              DD_CIVISIBILITY_AGENTLESS_LOGS_PORT: receiver.port,
              DD_API_KEY: '1', // TODO: check that if this is not set, this does not happen
              DD_SERVICE: 'my-service'
            },
            stdio: 'pipe'
          }
        )
        childProcess.on('exit', () => {
          receiverPromise.then(() => {
            assert.include(testOutput, 'Hello simple log!')
            assert.include(testOutput, 'span_id')
            done()
          })
        })

        childProcess.stdout.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.stderr.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
      })

      it('does not submit logs when DD_AGENTLESS_LOG_SUBMISSION_ENABLED is not set', (done) => {
        receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.includes('/api/v2/logs'), payloads => {
            throw new Error('should not report logs')
          }).catch(done)

        childProcess = exec(command,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              DD_CIVISIBILITY_AGENTLESS_LOGS_HOST: 'localhost',
              DD_CIVISIBILITY_AGENTLESS_LOGS_PORT: receiver.port,
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
        receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.includes('/api/v2/logs'), payloads => {
            throw new Error('should not report logs')
          }).catch(done)

        childProcess = exec(command,
          {
            cwd,
            env: {
              ...getCiVisEvpProxyConfig(receiver.port),
              DD_AGENTLESS_LOG_SUBMISSION_ENABLED: '1',
              DD_CIVISIBILITY_AGENTLESS_LOGS_HOST: 'localhost',
              DD_CIVISIBILITY_AGENTLESS_LOGS_PORT: receiver.port,
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
