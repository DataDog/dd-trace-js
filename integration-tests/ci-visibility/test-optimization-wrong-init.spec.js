'use strict'

const { exec } = require('child_process')

const { assert } = require('chai')

const { createSandbox, getCiVisAgentlessConfig } = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')

describe('test optimization wrong init', () => {
  let sandbox, cwd, receiver, childProcess, processOutput

  before(async () => {
    sandbox = await createSandbox(['jest'], true)
    cwd = sandbox.folder
  })

  after(async () => {
    await sandbox.remove()
  })

  beforeEach(async function () {
    processOutput = ''
    receiver = await new FakeCiVisIntake().start()
  })

  afterEach(async () => {
    childProcess.kill()
    await receiver.stop()
  })

  it('does not initialize test optimization plugins if Test Optimization mode is not enabled', (done) => {
    const eventsPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url === '/v0.4/traces', (tracesRequests) => {
        const spans = tracesRequests.flatMap(trace => trace.payload).flatMap(request => request)
        const includesTestOptimizationSpans = spans.some(span => span.name.includes('jest'))
        if (spans.length === 0) {
          throw new Error('No spans were sent')
        }
        if (includesTestOptimizationSpans) {
          throw new Error('Test Optimization spans should not be sent')
        }
      }, 5000)

    const envVars = getCiVisAgentlessConfig(receiver.port)

    const {
      NODE_OPTIONS, // we don't want to initialize dd-trace in Test Optimization mode
      ...restEnvVars
    } = envVars

    childProcess = exec('node ./ci-visibility/test-optimization-wrong-init/test-optimization-wrong-init.js',
      {
        cwd,
        env: {
          ...process.env,
          ...restEnvVars,
          DD_TRACE_DEBUG: '1'
        },
        stdio: 'pipe'
      }
    )

    childProcess.stderr.on('data', (chunk) => {
      processOutput += chunk.toString()
    })

    childProcess.stdout.on('data', (chunk) => {
      processOutput += chunk.toString()
    })

    childProcess.on('exit', () => {
      assert.include(processOutput, 'Plugin "jest" is not initialized because Test Optimization mode is not enabled.')
      assert.include(processOutput, 'PASS ci-visibility/test-optimization-wrong-init/sum-wrong-init-test.js')
      eventsPromise.then(() => {
        done()
      }).catch(done)
    })
  })
})
