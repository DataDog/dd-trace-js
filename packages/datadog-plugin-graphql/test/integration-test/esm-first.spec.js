'use strict'

const assert = require('node:assert/strict')

const semver = require('semver')

const { engines, nodeMaxMajor } = require('../../../../package.json')
const {
  FakeAgent,
  sandboxCwd,
  spawnPluginIntegrationTestProcAndExpectExit,
  useSandbox,
} = require('../../../../integration-tests/helpers')
const { isTrue } = require('../../../dd-trace/src/guardrails/util')

// GraphQL 17 selects its module-sync export only when require(esm) is enabled.
const supportedRuntime = isTrue(process.env.DD_INJECT_FORCE) ||
  semver.satisfies(process.version, `${engines.node} <${nodeMaxMajor}`)
// eslint-disable-next-line n/no-unsupported-features/node-builtins -- Feature detection skips unsupported runtimes.
const describeEsmFirst = supportedRuntime && process.features.require_module ? describe : describe.skip

describeEsmFirst('GraphQL ESM-first exports', () => {
  for (const version of ['16.14.2', '17.0.2']) {
    describe(`graphql@${version}`, () => {
      let agent

      useSandbox([`graphql@${version}`], false, [
        './packages/datadog-plugin-graphql/test/integration-test/esm-first.mjs',
      ])

      beforeEach(async () => {
        agent = await new FakeAgent().start()
      })

      afterEach(async () => {
        await agent.stop()
      })

      for (const mode of ['import', 'require']) {
        for (const outcome of ['success', 'error', 'disabled']) {
          it(`traces ${mode} with ${outcome}`, async () => {
            const received = agent.assertMessageReceived(({ payload }) => {
              const spans = payload.flat()
              const graphqlSpans = spans.filter(span => span.name.startsWith('graphql.'))
              if (outcome === 'disabled') {
                assert.equal(graphqlSpans.length, 0)
                assert.ok(spans.some(span => span.name === 'test.graphql'))
                return
              }

              const counts = {}
              for (const span of graphqlSpans) counts[span.name] = (counts[span.name] || 0) + 1
              assert.deepEqual(counts, {
                'graphql.parse': 2,
                'graphql.validate': 1,
                'graphql.execute': 1,
                'graphql.resolve': 1,
              })

              const execute = graphqlSpans.find(span => span.name === 'graphql.execute')
              const resolve = graphqlSpans.find(span => span.name === 'graphql.resolve')
              assert.equal(execute.resource, 'query Hello{hello(name:"")}')
              assert.equal(execute.meta['graphql.source'], 'query Hello { greeting: hello(name: "world") }')
              assert.equal(resolve.resource, 'hello:String')
              assert.equal(execute.error, outcome === 'error' ? 1 : 0)
              assert.equal(resolve.error, outcome === 'error' ? 1 : 0)
              if (outcome === 'error') {
                assert.equal(execute.meta['error.message'], 'resolver failed')
                assert.equal(resolve.meta['error.message'], 'resolver failed')
              }
            })

            await Promise.all([
              received,
              spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), 'esm-first.mjs', agent.port, {
                NODE_OPTIONS: '--import dd-trace/register.js',
                GRAPHQL_VERSION: version,
                LOAD_MODE: mode,
                OUTCOME: outcome,
              }),
            ])
          }).timeout(50000)
        }
      }
    })
  }
})
