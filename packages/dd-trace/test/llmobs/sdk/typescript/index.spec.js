'use strict'

const { describe, it, beforeEach, afterEach, before, after } = require('mocha')
const path = require('node:path')
const { execSync } = require('node:child_process')

const {
  FakeAgent,
  createSandbox,
  spawnProc
} = require('../../../../../../integration-tests/helpers')
const { assertLlmObsSpanEvent } = require('../../util')

function check (expected, actual) {
  for (const expectedLLMObsSpanIdx in expected) {
    const expectedLLMObsSpan = expected[expectedLLMObsSpanIdx]
    const actualLLMObsSpan = actual[expectedLLMObsSpanIdx]
    assertLlmObsSpanEvent(actualLLMObsSpan, expectedLLMObsSpan)
  }
}

const testVersions = [
  '^1',
  '^2',
  '^3',
  '^4',
  '^5'
]

const testCases = [
  {
    name: 'not initialized',
    file: 'noop'
  },
  {
    name: 'instruments an application with decorators',
    file: 'index',
    setup: (agent, results = {}) => {
      const llmobsRes = agent.assertLlmObsPayloadReceived(({ payload }) => {
        results.llmobsSpans = payload.flatMap(item => item.spans)
      })

      const apmRes = agent.assertMessageReceived(({ payload }) => {
        results.apmSpans = payload
      })

      return [llmobsRes, apmRes]
    },
    runTest: ({ llmobsSpans, apmSpans }) => {
      const actual = llmobsSpans
      const expected = [{
        span: apmSpans[0][0],
        spanKind: 'agent',
        name: 'runChain',
        tags: {
          ml_app: 'test',
          foo: 'bar',
          bar: 'baz'
        },
        inputData: 'this is a',
        outputData: 'test'
      }]

      check(expected, actual)
    }
  }
]

describe('typescript', () => {
  let agent
  let proc
  let sandbox

  for (const version of testVersions) {
    // TODO: Figure out the real version without using `npm show` as it causes rate limit errors.
    context(`with version ${version}`, () => {
      before(async function () {
        this.timeout(20000)
        sandbox = await createSandbox(
          [`typescript@${version}`], false, ['./packages/dd-trace/test/llmobs/sdk/typescript/*']
        )
      })

      after(async () => {
        await sandbox.remove()
      })

      beforeEach(async () => {
        agent = await new FakeAgent().start()
      })

      afterEach(async () => {
        proc && proc.kill()
        await agent.stop()
      })

      for (const test of testCases) {
        const { name, file } = test
        it(name, async function () {
          this.timeout(20000)

          const cwd = sandbox.folder

          const results = {}
          const waiters = test.setup ? test.setup(agent, results) : []

          // compile typescript
          execSync(
            `tsc --target ES6 --experimentalDecorators --module commonjs --sourceMap ${file}.ts`,
            { cwd, stdio: 'inherit' }
          )

          proc = await spawnProc(
            path.join(cwd, `${file}.js`),
            { cwd, env: { DD_TRACE_AGENT_PORT: agent.port, DD_TAGS: 'foo:bar, bar:baz' } }
          )

          await Promise.all(waiters)

          // some tests just need the file to run, not assert payloads
          test.runTest && test.runTest(results)
        })
      }
    })
  }
})
