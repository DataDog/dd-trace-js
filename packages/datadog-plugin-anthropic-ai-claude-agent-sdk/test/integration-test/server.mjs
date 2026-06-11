/**
 * ESM Integration Test Script
 *
 * This file exercises the @anthropic-ai/claude-agent-sdk library to generate spans.
 * It runs as a short-lived subprocess with dd-trace initialized via --loader flag.
 * Do NOT call process.exit() — let Node exit naturally so dd-trace can flush spans.
 */

import 'dd-trace/init.js'
import { query } from '@anthropic-ai/claude-agent-sdk'

// Exercise the library operations
async function main () {
  try {
    // Exercise query() — iterates full AsyncGenerator so span finishes
    const gen = query({ prompt: 'test', options: { maxTurns: 1 } })
    // eslint-disable-next-line no-unused-vars
    for await (const _msg of gen) { /* consume stream */ }

  } catch (err) {
    // Log errors but allow natural exit so dd-trace flushes spans to the agent.
    console.error('Test error (may be expected in CI without real credentials):', err.message)
  }
}

main()
