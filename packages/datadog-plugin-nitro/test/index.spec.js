'use strict'

const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

createIntegrationTestSuite('nitro', 'h3', {
  category: 'http-server',
}, (meta) => {
  const { agent } = meta

  before(async () => {
    await testSetup.setup(meta.mod)
  })

  after(async () => {
    await testSetup.teardown()
  })

  describe('h3.request - request', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'nitro.server.request',
        type: 'web',
        meta: {
          component: 'nitro',
          'span.kind': 'server',
          'http.method': 'GET',
          'http.route': '/hello',
        },
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
        },
        error: 1,
      })

      try {
        await testSetup.tracingPluginError()
      } catch {
        // request may complete with a 500 — that's not an exception on the client side
      }

      return traceAssertion
    })
  })
})
