'use strict'

const assert = require('node:assert')

const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

createIntegrationTestSuite('nitro', 'h3', {
  category: 'http-server',
}, (meta) => {
  const { agent } = meta

  before(async () => {
    await testSetup.setup(meta)
  })

  after(async () => {
    await testSetup.teardown()
  })

  describe('h3.request - request', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(span => {
        assert.strictEqual(span.name, 'nitro.server.request')
        assert.strictEqual(span.type, 'web')
        assert.strictEqual(span.resource, 'GET /hello')
        // Service must be the tracer's default test service so traces are attributed correctly.
        assert.strictEqual(span.service, 'test')
        assert.deepStrictEqual({
          component: span.meta.component,
          'span.kind': span.meta['span.kind'],
          'http.method': span.meta['http.method'],
          'http.route': span.meta['http.route'],
          'http.status_code': span.meta['http.status_code'],
        }, {
          component: 'nitro',
          'span.kind': 'server',
          'http.method': 'GET',
          'http.route': '/hello',
          'http.status_code': '200',
        })
      })

      // Also verify the library itself still works after instrumentation (no broken responses).
      const response = await testSetup.tracingPlugin()
      assert.strictEqual(response.statusCode, 200)

      return traceAssertion
    })

    it('should capture http.url with the request path', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(span => {
        assert.strictEqual(span.name, 'nitro.server.request')
        assert.strictEqual(span.meta['http.method'], 'GET')
        assert.ok(span.meta['http.url'], 'expected http.url to be set')
        assert.ok(
          span.meta['http.url'].includes('/hello'),
          `expected http.url to contain '/hello', got ${span.meta['http.url']}`
        )
      })

      await testSetup.tracingPlugin()

      return traceAssertion
    })

    it('should capture the route pattern (not the actual path) for parameterized routes', async () => {
      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'nitro.server.request',
        type: 'web',
        resource: 'GET /users/:id',
        meta: {
          component: 'nitro',
          'span.kind': 'server',
          'http.method': 'GET',
          'http.route': '/users/:id',
          'http.status_code': '200',
        },
      })

      await testSetup.tracingPluginParameterized()

      return traceAssertion
    })

    it('should propagate distributed trace context from incoming headers', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(span => {
        assert.strictEqual(span.meta['http.method'], 'GET')
        assert.strictEqual(
          span.trace_id.toString(), '1234567890',
          'trace_id should be inherited from x-datadog-trace-id header'
        )
        assert.strictEqual(
          span.parent_id.toString(), '9876543210',
          'parent_id should be inherited from x-datadog-parent-id header'
        )
      })

      await testSetup.tracingPluginWithHeaders({
        'x-datadog-trace-id': '1234567890',
        'x-datadog-parent-id': '9876543210',
        'x-datadog-sampling-priority': '1',
      })

      return traceAssertion
    })

    it('should not generate spans for middleware (type=middleware) — only the matched route', async () => {
      const traceAssertion = agent.assertSomeTraces(traces => {
        // Exactly one trace, exactly one span — middleware (registered via app.use) must
        // not produce its own span. Without the type==='route' filter, app.use(() => {})
        // would emit a second tracing:h3.request:* event per request.
        assert.strictEqual(traces.length, 1, `expected exactly 1 trace, got ${traces.length}`)
        assert.strictEqual(traces[0].length, 1, `expected exactly 1 span, got ${traces[0].length}`)
        assert.strictEqual(traces[0][0].name, 'nitro.server.request')
        assert.strictEqual(traces[0][0].resource, 'GET /hello')
      })

      await testSetup.tracingPlugin()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'nitro.server.request',
        meta: {
          component: 'nitro',
          'span.kind': 'server',
          'error.type': 'Error',
          'error.message': 'nitro test boom',
          'http.status_code': '500',
        },
        error: 1,
      })

      // The h3 handler should still return a real 500 response — verify the library wasn't
      // broken by instrumentation. The client-side request itself does not throw on HTTP 500.
      const response = await testSetup.tracingPluginError()
      assert.strictEqual(response.statusCode, 500)

      return traceAssertion
    })
  })
})
