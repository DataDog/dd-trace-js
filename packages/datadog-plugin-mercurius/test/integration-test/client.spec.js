'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const semver = require('semver')

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc,
  varySandbox,
  stopProc,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

/** @typedef {{ name: string, resource: string, meta: Record<string, string> }} GraphQLRequestSpan */

/**
 * @param {string} url
 * @param {Record<string, string>} body
 */
function post (url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('esm', () => {
  let agent
  let proc

  // mercurius 15+ ships fastify 5, which requires Node 20.9+; restrict to the
  // 13/14 line on older Node so the oldest-LTS CI leg does not sandbox an
  // unsupported runtime. Mirrors the non-ESM spec's `supportedOnThisNode` gate.
  const supportedRange = semver.satisfies(process.versions.node, '<20.9.0') ? '<15' : '*'

  withVersions('mercurius', 'mercurius', supportedRange, (version, _, resolvedVersion) => {
    // mercurius <=14 needs fastify 4 (fastify-plugin ^4); 15+ needs fastify 5.
    const fastifyDep = semver.satisfies(resolvedVersion, '>=15') ? 'fastify@5' : 'fastify@4'

    useSandbox([`'mercurius@${version}'`, `'${fastifyDep}'`], false, [
      './packages/datadog-plugin-mercurius/test/integration-test/*'])

    const variants = varySandbox('server.mjs', {
      bindingName: 'mercurius',
      packageName: 'mercurius',
      defaultExport: true,
      namedExports: [],
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    for (const variant of Object.keys(variants)) {
      it(`is instrumented ${variant}`, async () => {
        proc = await spawnPluginIntegrationTestProc(sandboxCwd(), variants[variant], agent.port)

        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
          assert.strictEqual(checkSpansForServiceName(payload, 'graphql.request'), true)
        })

        await post(`${proc.url}/graphql`, { query: 'query MyQuery { hello(name: "world") }' })

        await res
      }).timeout(50000)

      it(`keeps warm operation metadata without graphql-jit instrumentation ${variant}`, async () => {
        proc = await spawnPluginIntegrationTestProc(
          sandboxCwd(),
          variants[variant],
          agent.port,
          {
            DD_TRACE_DISABLED_INSTRUMENTATIONS: 'graphql-jit',
            MERCURIUS_JIT: '1',
          }
        )

        const source = 'query First { hello(name: "first") } query Second { hello(name: "second") }'
        await post(`${proc.url}/graphql`, { query: source, operationName: 'First' })
        await post(`${proc.url}/graphql`, { query: source, operationName: 'Second' })

        const assertion = agent.assertMessageReceived(({ payload }) => {
          const request = payload.flat().find(span =>
            span.name === 'graphql.request' && span.meta['graphql.operation.name'] === 'Second')

          assert.ok(request, 'expected the warm Second request span')
          assert.match(request.resource, /query Second/)
          assert.strictEqual(request.meta['graphql.operation.type'], 'query')
        })

        await Promise.all([
          assertion,
          post(`${proc.url}/graphql`, { query: source, operationName: 'Second' }),
        ])
      }).timeout(50000)

      if (semver.satisfies(resolvedVersion, '>=15')) {
        it(`keeps warm pre-parsed operation metadata without graphql-jit instrumentation ${variant}`, async () => {
          proc = await spawnPluginIntegrationTestProc(
            sandboxCwd(),
            variants[variant],
            agent.port,
            {
              DD_TRACE_DISABLED_INSTRUMENTATIONS: 'graphql-jit',
              MERCURIUS_JIT: '1',
            }
          )

          async function requestParsedAndAssert () {
            /**
             * @param {{ payload: GraphQLRequestSpan[][] }} message
             */
            const assertion = agent.assertMessageReceived(({ payload }) => {
              const request = payload.flat().find(span => span.name === 'graphql.request')

              assert.ok(request, 'expected the pre-parsed request span')
              assert.strictEqual(request.meta['graphql.operation.name'], 'ParsedAstWarmDisabled')
              assert.match(request.resource, /query ParsedAstWarmDisabled/)
              assert.strictEqual(request.meta['graphql.operation.type'], 'query')
            })

            await Promise.all([
              assertion,
              fetch(`${proc.url}/parsed`),
            ])
          }

          await requestParsedAndAssert()
          await requestParsedAndAssert()
          await requestParsedAndAssert()
        }).timeout(50000)
      }
    }
  })
})
