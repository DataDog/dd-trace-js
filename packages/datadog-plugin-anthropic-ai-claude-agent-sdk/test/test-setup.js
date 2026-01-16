'use strict'

/**
 * Sample app for the `@anthropic-ai/claude-agent-sdk` instrumentation testing.
 *
 * This app exercises the main instrumentation targets:
 * - query() - Main API for agent queries (returns async generator)
 * - unstable_v2_prompt() - Simplified API for single prompts
 * - SDKSession.prototype.send() - Session-based message sending
 *
 * Note: This is a CJS wrapper that dynamically imports the ESM module.
 */

class AnthropicAiClaudeAgentSdkTestSetup {
  async setup (module) {
    this.queryFn = module.query
    this.unstable_v2_promptFn = module.unstable_v2_prompt
    this.unstable_v2_createSessionFn = module.unstable_v2_createSession

    // Default options for SDK calls
    this.defaultOptions = {
      // Use a simple model
      model: 'claude-sonnet-4-20250514',
      // Don't persist sessions during testing
      persistSession: false,
      // Set a reasonable budget limit
      maxBudgetUsd: 0.01,
      // Limit turns
      maxTurns: 1
    }
  }

  async teardown () {
    // Clean up any resources if needed
  }

  // --- Operations ---

  // Helper to consume async generator and return results
  async _consumeAsyncGenerator (generator) {
    const results = []
    for await (const item of generator) {
      results.push(item)
    }
    return results
  }

  // query() - returns async generator
  async query () {
    const generator = this.queryFn('Say hello in one word', this.defaultOptions)
    return this._consumeAsyncGenerator(generator)
  }

  async queryError () {
    // Use invalid model to trigger an error
    const generator = this.queryFn('Say hello', {
      ...this.defaultOptions,
      model: 'invalid-model-that-does-not-exist'
    })
    return this._consumeAsyncGenerator(generator)
  }

  // unstable_v2_prompt() - async function
  async unstablev2prompt () {
    return this.unstable_v2_promptFn('Say hello in one word', this.defaultOptions)
  }

  async unstablev2promptError () {
    // Use invalid model to trigger an error
    return this.unstable_v2_promptFn('Say hello', {
      ...this.defaultOptions,
      model: 'invalid-model-that-does-not-exist'
    })
  }

  // SDKSession.send() - async function
  async sDKSessionSend () {
    const session = this.unstable_v2_createSessionFn(this.defaultOptions)
    return session.send('Say hello in one word')
  }

  async sDKSessionSendError () {
    // Create session with invalid model to trigger error on send
    const session = this.unstable_v2_createSessionFn({
      ...this.defaultOptions,
      model: 'invalid-model-that-does-not-exist'
    })
    return session.send('Say hello')
  }
}

module.exports = AnthropicAiClaudeAgentSdkTestSetup
