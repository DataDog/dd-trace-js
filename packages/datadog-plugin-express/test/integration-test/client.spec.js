'use strict'

const assert = require('node:assert/strict')
const { METHODS } = require('node:http')
const { inspect } = require('node:util')

const semver = require('semver')
const {
  FakeAgent,
  curlAndAssertMessage,
  spawnPluginIntegrationTestProc,
  sandboxCwd,
  useSandbox,
  varySandbox,
  stopProc,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
const httpRequest = require('../../../dd-trace/test/setup/helpers/http-client')

describe('esm', () => {
  withVersions('express', 'express', version => {
    let agent
    let proc

    useSandbox([`'express@${version}'`], false,
      ['./packages/datadog-plugin-express/test/integration-test/*'])

    const variants = varySandbox('server.mjs', {
      bindingName: 'express',
      packageName: 'express',
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
      describe('with DD_TRACE_MIDDLEWARE_TRACING_ENABLED unset', () => {
        it(`traces QUERY with a body loaded with ${variant}`, async function () {
          if (!METHODS.includes('QUERY') || !semver.intersects(version, '>=4.16.0')) {
            // QUERY needs runtime support, and the fixture uses Express's built-in JSON parser.
            this.skip()
          }
          proc = await spawnPluginIntegrationTestProc(sandboxCwd(), variants[variant], agent.port)
          const traces = agent.assertMessageReceived(({ payload }) => {
            const spans = payload.flat()
            const requests = spans.filter(span => span.name === 'express.request')
            assert.strictEqual(requests.length, 1)
            assert.strictEqual(requests[0].resource, 'QUERY /api/reports/:id')
            assert.strictEqual(requests[0].meta['http.method'], 'QUERY')
            assert.strictEqual(requests[0].meta['http.route'], '/api/reports/:id')
            assert.strictEqual(requests[0].meta['http.status_code'], '200')
            assert.strictEqual(spans.filter(span => span.resource === 'handleQuery').length, 1)
          })
          const [, response] = await Promise.all([
            traces,
            httpRequest({
              url: new URL('/api/reports/42', proc.url).href,
              method: 'QUERY',
              data: { filter: 'books' },
            }),
          ])
          assert.deepStrictEqual(response.data, { id: '42', filter: 'books' })
        }).timeout(50000)

        it(`is instrumented loaded with ${variant}`, async () => {
          proc = await spawnPluginIntegrationTestProc(sandboxCwd(), variants[variant], agent.port)
          const numberOfSpans = semver.intersects(version, '<5.0.0') ? 4 : 2
          const whichMiddleware = semver.intersects(version, '<5.0.0')
            ? 'express'
            : 'router'

          return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
            assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
            assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
            assert.strictEqual(payload.length, 1)
            assert.ok(Array.isArray(payload[0]), `Expected array, got ${inspect(payload[0])}`)
            assert.strictEqual(payload[0].length, numberOfSpans)
            assert.strictEqual(payload[0][0].name, 'express.request')
            assert.strictEqual(payload[0][1].name, `${whichMiddleware}.middleware`)
          })
        }).timeout(50000)
      })

      describe('with DD_TRACE_MIDDLEWARE_TRACING_ENABLED=true', () => {
        before(() => {
          process.env.DD_TRACE_MIDDLEWARE_TRACING_ENABLED = false
        })

        after(() => {
          delete process.env.DD_TRACE_MIDDLEWARE_TRACING_ENABLED
        })

        it('disables middleware spans when config.middlewareTracingEnabled is false via env var', async () => {
          proc = await spawnPluginIntegrationTestProc(sandboxCwd(), variants[variant], agent.port)
          const numberOfSpans = 1

          return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
            assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
            assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
            assert.strictEqual(payload.length, 1)
            assert.ok(Array.isArray(payload[0]), `Expected array, got ${inspect(payload[0])}`)
            assert.strictEqual(payload[0].length, numberOfSpans)
            assert.strictEqual(payload[0][0].name, 'express.request')
          })
        }).timeout(50000)
      })
    }
  })
})
