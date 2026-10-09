// The tracer must be initialized before `ai` is evaluated.
import './ai-init.mjs'

import dc from 'node:diagnostics_channel'

import { generateText } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'

const model = new MockLanguageModelV4({
  doGenerate: async () => ({
    content: [{ type: 'text', text: 'ok' }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
    warnings: [],
  }),
})

const { text } = await generateText({ model, prompt: 'hello' })

// Only the activated integration subscribes to the channel the AI SDK publishes itself.
// eslint-disable-next-line no-console
console.log(JSON.stringify({
  telemetrySubscribed: dc.channel('tracing:ai:telemetry:asyncEnd').hasSubscribers,
  text,
}))
