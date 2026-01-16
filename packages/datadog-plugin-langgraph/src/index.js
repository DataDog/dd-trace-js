'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const LanggraphLLMObsPlugin = require('../../dd-trace/src/llmobs/plugins/langgraph')
const clientPlugin = require('./client')
const streamPlugin = require('./stream')

class LanggraphPlugin extends CompositePlugin {
  static id = '@langchain/langgraph'
  // Ordering is important: LLMObs plugins must come first so that annotations
  // are added before the span finishes. The tracing plugin's bindStart still
  // creates the span first (bindStart runs before start in the event cycle).
  //
  // Note: The internal _runWithRetry plugin is intentionally not included here
  // because it creates additional child spans that complicate the test infrastructure.
  // The test helper `useLlmObs` only waits for the first trace payload, and internal
  // spans arriving in separate payloads cause span matching issues in tests.
  static plugins = {
    llmobs: LanggraphLLMObsPlugin,
    client: clientPlugin,
    stream: streamPlugin
  }
}

module.exports = LanggraphPlugin
