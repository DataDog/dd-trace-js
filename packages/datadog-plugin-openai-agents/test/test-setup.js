'use strict'

/**
 * Test setup for \@openai/agents instrumentation.
 *
 * Exercises both instrumented methods:
 *   1. run()        – top-level convenience function
 *   2. Runner.run() – class method that orchestrates the agent loop
 *
 * Uses a FakeModel so no real OpenAI API key is required.
 */

class FakeModel {
  constructor (shouldError = false) {
    this.shouldError = shouldError
  }

  async getResponse () {
    if (this.shouldError) {
      throw new Error('Fake model error')
    }
    return {
      usage: {
        requests: 1,
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello from fake model' }],
          status: 'completed',
        },
      ],
      responseId: 'fake-response-id',
    }
  }

  async * getStreamedResponse () {
    if (this.shouldError) {
      throw new Error('Fake model error')
    }
    yield {
      type: 'response_completed',
      response: await this.getResponse(),
    }
  }
}

class FakeModelProvider {
  constructor (shouldError = false) {
    this.shouldError = shouldError
  }

  getModel () {
    return new FakeModel(this.shouldError)
  }
}

class OpenaiAgentsTestSetup {
  async setup (module) {
    this.module = module
    this.Agent = module.Agent
    this.Runner = module.Runner
    this._run = module.run
    this.setDefaultModelProvider = module.setDefaultModelProvider

    // Set up the default model provider with our fake
    this.setDefaultModelProvider(new FakeModelProvider(false))

    // Create a basic agent for testing
    this.agent = new this.Agent({
      name: 'test-agent',
      instructions: 'You are a test agent.',
      model: 'fake-model',
    })
  }

  async teardown () {
    this.module = undefined
    this.agent = undefined
  }

  // --- Operations ---

  async run () {
    return await this._run(this.agent, 'Hello')
  }

  async runError () {
    // Use an explicit Runner with an error provider because the top-level run()
    // delegates to a singleton Runner whose modelProvider is captured at
    // construction time and cannot be changed after the fact.
    const runner = new this.Runner({
      modelProvider: new FakeModelProvider(true),
    })
    return await runner.run(this.agent, 'Hello')
  }

  async runnerRun () {
    const runner = new this.Runner({
      modelProvider: new FakeModelProvider(false),
    })
    return await runner.run(this.agent, 'Hello')
  }

  async runnerRunError () {
    const runner = new this.Runner({
      modelProvider: new FakeModelProvider(true),
    })
    return await runner.run(this.agent, 'Hello')
  }
}

module.exports = OpenaiAgentsTestSetup
