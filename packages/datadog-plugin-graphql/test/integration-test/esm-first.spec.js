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
// The production loader applies additional runtime gates after registerHooks became available.
// eslint-disable-next-line n/no-unsupported-features/node-builtins -- Feature detection for require(esm).
const hasRequireEsmHooks = process.features.require_module &&
  require('import-in-the-middle/supports-sync-hooks.mjs').supportsSyncHooks()

describeEsmFirst('GraphQL ESM-first exports', () => {
  for (const version of ['16.14.2', '17.0.2']) {
    describe(`graphql@${version}`, () => {
      let agent

      const graphql17 = semver.gte(version, '17.0.0')
      const dependencies = [`graphql@${version}`]
      if (graphql17) dependencies.push('graphql-jit@0.10.0')
      useSandbox(dependencies, false, [
        './packages/datadog-plugin-graphql/test/integration-test/esm-first.mjs',
      ])

      beforeEach(async () => {
        agent = await new FakeAgent().start()
      })

      afterEach(async () => {
        await agent.stop()
      })

      const modes = [
        { name: 'import', mode: 'import', preload: true },
        { name: 'require', mode: 'require', preload: true },
        { name: 'require executeSync', mode: 'require', preload: true, executeSync: true },
      ]
      if (graphql17) {
        modes.push(
          { name: 'plain require', mode: 'require' },
          { name: 'plain require executeSync', mode: 'require', executeSync: true },
          { name: 'import executeSync', mode: 'import', preload: true, executeSync: true }
        )
      }

      for (const { name, mode, preload, executeSync } of modes) {
        // eslint-disable-next-line n/no-unsupported-features/node-builtins -- Match GraphQL's native diagnostics gate.
        const native = graphql17 && typeof process.getBuiltinModule === 'function'
        const rewritten = preload && (!graphql17 || !executeSync && (mode === 'import' || hasRequireEsmHooks))
        const outcomes = ['success', 'error', 'disabled']
        if (!preload && !executeSync) outcomes.push('thenable', 'getter', 'auto')
        if (graphql17 && mode === 'require' && !executeSync) outcomes.push('phase-errors')
        if (graphql17 && mode === 'require') {
          if (rewritten) outcomes.push('reentrant')
          if (!preload && executeSync) outcomes.push('incremental')
          if (!preload && !executeSync) outcomes.push('subpaths', 'variable-filter', 'package-disabled')
        }

        for (const outcome of outcomes) {
          const supported = native || rewritten || outcome === 'disabled'
          const test = supported ? it : it.skip

          test(`traces ${name} with ${outcome}`, async () => {
            const received = agent.assertMessageReceived(({ payload }) => {
              const spans = payload.flat()
              const graphqlSpans = spans.filter(span => span.name.startsWith('graphql.'))
              if (outcome === 'disabled' || outcome === 'package-disabled') {
                assert.equal(graphqlSpans.length, 0)
                assert.ok(spans.some(span => span.name === 'test.graphql'))
                return
              }

              const executions = graphqlSpans.filter(span => span.name === 'graphql.execute')
              if (outcome === 'reentrant' || outcome === 'incremental') {
                assert.equal(executions.length, outcome === 'reentrant' ? 2 : 1)
                if (outcome === 'reentrant') assert.ok(graphqlSpans.some(span => span.name === 'graphql.resolve'))
                return
              }
              if (outcome === 'subpaths') {
                assert.deepEqual(executions.map(span => span.resource).sort(),
                  ['query Subpath', 'query TopLevel{hello(name:"")}'])
                return
              }

              const counts = {}
              for (const span of graphqlSpans) counts[span.name] = (counts[span.name] || 0) + 1
              const phaseErrors = outcome === 'phase-errors'
              assert.deepEqual(counts, {
                'graphql.parse': phaseErrors ? 3 : 2,
                'graphql.validate': phaseErrors ? 2 : 1,
                'graphql.execute': 1,
                ...(rewritten ? { 'graphql.resolve': 1 } : {}),
              })
              if (phaseErrors) {
                const errors = graphqlSpans.filter(span => span.error === 1)
                assert.equal(errors.length, 2)
                assert.equal(errors.find(span => span.name === 'graphql.parse').meta['error.message'],
                  'Syntax Error: Expected Name, found <EOF>.')
                assert.equal(errors.find(span => span.name === 'graphql.validate').meta['error.message'],
                  'validation failed')
                assert.equal(spans.find(span => span.name === 'test.graphql').error, 0)
              }

              const execute = graphqlSpans.find(span => span.name === 'graphql.execute')
              const resolve = graphqlSpans.find(span => span.name === 'graphql.resolve')
              assert.equal(execute.resource, 'query Hello{hello(name:"")}')
              if (outcome !== 'auto') {
                assert.equal(execute.meta['graphql.source'], 'query Hello { greeting: hello(name: "world") }')
              }
              assert.equal(execute.error, outcome === 'error' ? 1 : 0)
              if (outcome === 'error') {
                assert.equal(execute.meta['error.message'], 'resolver failed')
              }
              if (rewritten) {
                assert.equal(resolve.resource, 'hello:String')
                assert.equal(resolve.meta['graphql.source'], 'greeting: hello(name: "world")')
                assert.equal(resolve.error, outcome === 'error' ? 1 : 0)
                if (outcome === 'error') assert.equal(resolve.meta['error.message'], 'resolver failed')
              }
            })

            await Promise.all([
              received,
              spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), 'esm-first.mjs', agent.port, {
                // An explicit no-op preload overrides the integration helper's default loader.
                NODE_OPTIONS: preload ? '--import dd-trace/register.js' : '--import data:text/javascript,',
                DD_TRACE_DISABLED_INSTRUMENTATIONS: outcome === 'package-disabled' ? 'graphql' : '',
                EXECUTE_SYNC: executeSync ? 'true' : 'false',
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
