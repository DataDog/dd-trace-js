'use strict'

const { once } = require('node:events')
const assert = require('node:assert')
const { inspect } = require('node:util')
const { exec } = require('child_process')

const { sandboxCwd, useSandbox, getCiVisAgentlessConfig } = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { NODE_MAJOR } = require('../../version')

const isLatestCucumberSupported = NODE_MAJOR === 22 || NODE_MAJOR === 24 || NODE_MAJOR >= 26

// no playwright because it has no programmatic API
// no cypress because it's not a proper dd-trace plugin
const testFrameworks = [
  {
    testFramework: 'mocha',
    command: 'node ./ci-visibility/test-optimization-wrong-init/run-mocha.js',
    expectedOutput: '1 passing',
  },
  {
    testFramework: 'jest',
    command: 'node ./ci-visibility/test-optimization-wrong-init/run-jest.js',
    expectedOutput: [
      'PASS ci-visibility/test-optimization-wrong-init/sum-wrong-init-test.js',
      'Test Suites:\\s+1 passed, 1 total',
    ].join('|'),
  },
  {
    testFramework: 'vitest',
    command: 'node ./ci-visibility/test-optimization-wrong-init/run-vitest.mjs',
    expectedOutput: '1 passed',
    extraTestContext: {
      TEST_DIR: 'ci-visibility/test-optimization-wrong-init/vitest-sum-wrong-init*',
      NODE_OPTIONS: '--import dd-trace/register.js',
    },
  },
  {
    testFramework: 'cucumber',
    command: './node_modules/.bin/cucumber-js ci-visibility/test-optimization-wrong-init-cucumber/*.feature',
    expectedOutput: '1 passed',
    extraTestContext: {
      NODE_OPTIONS: '-r dd-trace/init',
    },
  },
]

testFrameworks.forEach(({ testFramework, command, expectedOutput, extraTestContext }) => {
  describe(`test optimization wrong init for ${testFramework}`, () => {
    let cwd, receiver, childProcess, processOutput

    // cucumber@latest and vitest@4.x do not support every Node.js major in this matrix
    if (!isLatestCucumberSupported && testFramework === 'cucumber') return
    if (NODE_MAJOR <= 18 && testFramework === 'vitest') return

    const testFrameworks = ['jest', 'mocha', 'vitest']

    if (isLatestCucumberSupported) {
      testFrameworks.push('@cucumber/cucumber')
    }

    useSandbox(testFrameworks, true)

    before(() => {
      cwd = sandboxCwd()
    })

    beforeEach(async function () {
      processOutput = ''
      receiver = await new FakeCiVisIntake().start()
    })

    afterEach(async () => {
      childProcess.kill()
      await receiver.stop()
    })

    it('does not initialize test optimization plugins if Test Optimization mode is not enabled', async () => {
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url === '/v0.4/traces', (tracesRequests) => {
          const spans = tracesRequests.flatMap(trace => trace.payload).flatMap(request => request)
          const includesTestOptimizationSpans = spans.some(span => span.name.includes(testFramework))
          if (spans.length === 0) {
            throw new Error('No spans were sent')
          }
          if (includesTestOptimizationSpans) {
            throw new Error('Test Optimization spans should not be sent')
          }
        }, 10000)

      const envVars = getCiVisAgentlessConfig(receiver.port)

      const {
        NODE_OPTIONS, // we don't want to initialize dd-trace in Test Optimization mode
        ...restEnvVars
      } = envVars

      childProcess = exec(command,
        {
          cwd,
          env: {
            ...process.env,
            ...restEnvVars,
            DD_TRACE_DISABLED_INSTRUMENTATIONS: 'child_process',
            DD_TRACE_DEBUG: '1',
            ...extraTestContext,
          },
        }
      )

      childProcess.stderr?.on('data', (chunk) => {
        processOutput += chunk.toString()
      })

      childProcess.stdout?.on('data', (chunk) => {
        processOutput += chunk.toString()
      })

      await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])

      const reason = 'is not initialized because Test Optimization mode is not enabled.'
      const expectedSubstring = `Plugin "${testFramework}" ${reason}`
      assert.ok(processOutput.includes(expectedSubstring), `Got: ${inspect(processOutput)}`)
      assert.match(processOutput, new RegExp(expectedOutput))
    })
  })
})
