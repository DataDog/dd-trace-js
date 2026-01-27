'use strict'

const sinon = require('sinon')
const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const { useEnv } = require('../../../integration-tests/helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

// Set fake API key so OpenAI SDK initializes without throwing
useEnv({
  OPENAI_API_KEY: 'sk-DATADOG-ACCEPTANCE-TESTS'
})

createIntegrationTestSuite('openai-agents', '@openai/agents', {
  category: 'llm'
}, (meta) => {
  const { agent } = meta

  before(async () => {
    await testSetup.setup(meta.mod)
  })

  after(async () => {
    await testSetup.teardown()
  })

  describe('OpenAIChatCompletionsModel.getResponse() - chat_completion', () => {
    it('should generate span with correct tags (happy path)', async function () {
      this.timeout(10000)

      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'openai-agents.getResponse',
        meta: {
          component: 'openai-agents',
          'span.kind': 'client',
          'ai.request.model_provider': 'openai'
        }
      })

      try {
        await testSetup.openAIChatCompletionsModelGetResponse()
      } catch (err) {
        // API call will fail without real API key, but span should still be created
      }

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async function () {
      this.timeout(10000)

      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'openai-agents.getResponse',
        meta: {
          component: 'openai-agents',
          'span.kind': 'client',
          'ai.request.model_provider': 'openai',
          'error.type': 'Error'
        },
        error: 1
      })

      try {
        await testSetup.openAIChatCompletionsModelGetResponseError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })

    describe('peer service', () => {
      let computePeerServiceStub

      beforeEach(function () {
        const { tracer } = meta
        const plugin = tracer?._pluginManager?._pluginsByName?.['openai-agents']
        if (!plugin) {
          this.skip()
          return
        }
        computePeerServiceStub = sinon.stub(plugin._tracerConfig, 'spanComputePeerService').value(true)
      })

      afterEach(() => {
        if (computePeerServiceStub) {
          computePeerServiceStub.restore()
        }
      })

      it('should compute peer.service from ai.request.model_provider', async function () {
        this.timeout(10000)

        const traceAssertion = agent.assertFirstTraceSpan({
          name: 'openai-agents.getResponse',
          meta: {
            component: 'openai-agents',
            'span.kind': 'client',
            'ai.request.model_provider': 'openai',
            'peer.service': 'openai',
            '_dd.peer.service.source': 'ai.request.model_provider'
          }
        })

        try {
          await testSetup.openAIChatCompletionsModelGetResponse()
        } catch (err) {
          // API call will fail without real API key, but span should still be created
        }

        return traceAssertion
      })
    })
  })

  describe('OpenAIChatCompletionsModel.getStreamedResponse() - chat_completion_stream', () => {
    it('should generate span with correct tags (happy path)', async function () {
      this.timeout(10000)

      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'openai-agents.getStreamedResponse',
        meta: {
          component: 'openai-agents',
          'span.kind': 'client',
          'ai.request.model_provider': 'openai'
        }
      })

      try {
        await testSetup.openAIChatCompletionsModelGetStreamedResponse()
      } catch (err) {
        // API call will fail without real API key, but span should still be created
      }

      return traceAssertion
    })

    // Note: Streaming error tests are limited because getStreamedResponse returns
    // a non-promise object (stream). Errors occur during stream consumption,
    // not during the initial call, so we can't capture them in the span.
    it('should generate span for streaming error path', async function () {
      this.timeout(10000)

      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'openai-agents.getStreamedResponse',
        meta: {
          component: 'openai-agents',
          'span.kind': 'client',
          'ai.request.model_provider': 'openai'
        }
        // Note: error: 1 is not expected because streaming errors happen after the span completes
      })

      try {
        await testSetup.openAIChatCompletionsModelGetStreamedResponseError()
      } catch (err) {
        // Expected error during stream consumption
      }

      return traceAssertion
    })

    describe('peer service', () => {
      let computePeerServiceStub

      beforeEach(function () {
        const { tracer } = meta
        const plugin = tracer?._pluginManager?._pluginsByName?.['openai-agents']
        if (!plugin) {
          this.skip()
          return
        }
        computePeerServiceStub = sinon.stub(plugin._tracerConfig, 'spanComputePeerService').value(true)
      })

      afterEach(() => {
        if (computePeerServiceStub) {
          computePeerServiceStub.restore()
        }
      })

      it('should compute peer.service from ai.request.model_provider', async function () {
        this.timeout(10000)

        const traceAssertion = agent.assertFirstTraceSpan({
          name: 'openai-agents.getStreamedResponse',
          meta: {
            component: 'openai-agents',
            'span.kind': 'client',
            'ai.request.model_provider': 'openai',
            'peer.service': 'openai',
            '_dd.peer.service.source': 'ai.request.model_provider'
          }
        })

        try {
          await testSetup.openAIChatCompletionsModelGetStreamedResponse()
        } catch (err) {
          // API call will fail without real API key, but span should still be created
        }

        return traceAssertion
      })
    })
  })
})
