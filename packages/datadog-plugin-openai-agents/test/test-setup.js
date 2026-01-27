'use strict'

/**
 * Sample app for `\@openai/agents` to exercise instrumentation targets:
 * - OpenAIChatCompletionsModel.prototype.getResponse (non-streaming)
 * - OpenAIChatCompletionsModel.prototype.getStreamedResponse (streaming)
 */

class OpenaiAgentsTestSetup {
  async setup (module) {
    if (module.setOpenAIAPI) {
      module.setOpenAIAPI('chat_completions')
    }

    // Store references from the module
    this.Agent = module.Agent
    this.run = module.run
    this.tool = module.tool

    this.agent = null
    this.agentWithTools = null

    // Create a simple agent
    this.agent = new this.Agent({
      name: 'TestAssistant',
      instructions: 'You are a helpful assistant. Keep responses very brief (under 20 words).'
    })

    // Create an agent with a tool (requires zod for parameters)
    if (this.tool && module.z) {
      const getTimeTool = this.tool({
        name: 'get_current_time',
        description: 'Get the current time',
        parameters: module.z.object({}),
        execute: async () => {
          return `The current time is ${new Date().toISOString()}`
        }
      })

      this.agentWithTools = new this.Agent({
        name: 'DataAgent',
        instructions: 'You are a data agent. Use the provided tools when asked. Keep responses brief.',
        tools: [getTimeTool]
      })
    }
  }

  async teardown () {
    // Cleanup if needed
  }

  // --- Operations ---
  async openAIChatCompletionsModelGetResponse () {
    const result = await this.run(
      this.agent,
      'Say "Hello" in exactly one word.'
    )
    return result
  }

  async openAIChatCompletionsModelGetResponseError () {
    // Create an agent with an invalid model to trigger error
    const badAgent = new this.Agent({
      name: 'BadAgent',
      instructions: 'You are an agent.',
      model: 'invalid-model-name-that-does-not-exist'
    })

    await this.run(badAgent, 'Hello')
  }

  async openAIChatCompletionsModelGetStreamedResponse () {
    // Use streaming option to exercise getStreamedResponse
    const result = await this.run(
      this.agent,
      'Count from 1 to 3.',
      { stream: true }
    )

    // Consume the stream if it's an async iterable
    if (result.output && Symbol.asyncIterator in result.output) {
      // eslint-disable-next-line no-unused-vars
      for await (const event of result.output) {
        // Just consume the stream
      }
    }

    return result
  }

  async openAIChatCompletionsModelGetStreamedResponseError () {
    // Create an agent with an invalid model to trigger error in streaming
    const badAgent = new this.Agent({
      name: 'BadStreamAgent',
      instructions: 'You are an agent.',
      model: 'invalid-model-name-that-does-not-exist'
    })

    await this.run(badAgent, 'Hello', { stream: true })
  }
}

module.exports = OpenaiAgentsTestSetup
