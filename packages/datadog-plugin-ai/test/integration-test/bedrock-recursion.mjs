import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'

import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock'
import { generateText } from 'ai'

globalThis.crypto ??= webcrypto

const response = {
  stopReason: 'end_turn',
  output: {
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Reproduction completed.' }],
    },
  },
  usage: {
    inputTokens: 3,
    outputTokens: 3,
    totalTokens: 6,
  },
  metrics: { latencyMs: 1 },
}

const bedrock = createAmazonBedrock({
  region: 'us-east-1',
  fetch: () => Promise.resolve(new Response(JSON.stringify(response), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })),
})

const result = await generateText({
  model: bedrock('anthropic.claude-3-haiku-20240307-v1:0'),
  prompt: 'Run the Bedrock recursion reproduction.',
})

assert.strictEqual(result.text, 'Reproduction completed.')
