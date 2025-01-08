'use strict'

const { execSync } = require('child_process')
const {
  FakeAgent,
  createSandbox,
  spawnProc
} = require('../../../../../../integration-tests/helpers')
const chai = require('chai')
const path = require('path')
const { expectedLLMObsNonLLMSpanEvent, deepEqualWithMockValues } = require('../../util')

chai.Assertion.addMethod('deepEqualWithMockValues', deepEqualWithMockValues)

function check (expected, actual) {
  for (const expectedLLMObsSpanIdx in expected) {
    const expectedLLMObsSpan = expected[expectedLLMObsSpanIdx]
    const actualLLMObsSpan = actual[expectedLLMObsSpanIdx]
    expect(actualLLMObsSpan).to.deep.deepEqualWithMockValues(expectedLLMObsSpan)
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
        results.llmobsSpans = payload.spans
      })

      const apmRes = agent.assertMessageReceived(({ payload }) => {
        results.apmSpans = payload
      })

      return [llmobsRes, apmRes]
    },
    runTest: ({ llmobsSpans, apmSpans }) => {
      const actual = llmobsSpans
      const expected = [
        expectedLLMObsNonLLMSpanEvent({
          span: apmSpans[0][0],
          spanKind: 'agent',
          tags: {
            ml_app: 'test',
            language: 'javascript'
          },
          inputValue: 'this is a',
          outputValue: 'test'
        })
      ]

      check(expected, actual)
    }
  }
]

describe('typescript', () => {
  let agent
  let proc
  let sandbox

  for (const version of testVersions) {
    // TODO: Figure out the real version without using `npm show` as it's broken.
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
        it(name, async () => {
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
            { cwd, env: { DD_TRACE_AGENT_PORT: agent.port } }
          )

          await Promise.all(waiters)

          // some tests just need the file to run, not assert payloads
          test.runTest && test.runTest(results)
        })
      }
    })
  }
})
