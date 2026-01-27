'use strict'

// Using shimmer-based instrumentation instead of orchestrion rewriter
// The rewriter doesn't support private class fields (#fetchResponse, #client, etc.)
// See packages/datadog-instrumentations/src/openai-agents.js for the actual implementation
module.exports = []
