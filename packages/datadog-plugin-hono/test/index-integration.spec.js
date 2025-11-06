'use strict'

const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/integration-tests-setup')
const HonoTestSetup = require('./hono-test-setup')
const {
    ERROR_TYPE,
    ERROR_MESSAGE,
    ERROR_STACK
} = require('../../dd-trace/src/constants')

createIntegrationTestSuite('hono', 'hono', HonoTestSetup, {
    additionalPlugins: ['http'],
    pluginConfig: {},
    additionalPluginConfigs: [{ client: false }]
}, ({ testSetup, agent, tracer, it }) => {
    it('should do automatic instrumentation on routes', async () => {
        const result = await testSetup.testRoute(tracer)

        await agent.assertFirstTraceSpan(result.expectedSpan)
    })

    it('should do automatic instrumentation on nested routes', async () => {
        const result = await testSetup.testNestedRoute()

        await agent.assertFirstTraceSpan(result.expectedSpan)
    })

    it('should handle errors', async () => {
        const result = await testSetup.testError()

        await agent.assertFirstTraceSpan({
            ...result.expectedSpan,
            meta: {
                ...result.expectedSpan.meta,
                [ERROR_TYPE]: result.error.name,
                [ERROR_MESSAGE]: result.error.message,
                [ERROR_STACK]: result.error.stack
            }
        })
    })

    it('should have active scope within request', async () => {
        await testSetup.testActiveScope(tracer)
    })

    it('should extract its parent span from the headers', async () => {
        const result = await testSetup.testParentSpanExtraction(tracer)

        await agent.assertFirstTraceSpan(result.expectedSpan)
    })
})

