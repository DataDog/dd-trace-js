'use strict'

const tracer = require('dd-trace').init({ startupLogs: false })
// eslint-disable-next-line n/no-unsupported-features/node-builtins
const { tracingChannel } = require('node:diagnostics_channel')

tracer.use('ai')

if (!tracingChannel('ai:telemetry').hasSubscribers) {
  throw new Error('AI SDK telemetry channel was not activated')
}

const { generateText } = require('ai')
const { MockLanguageModelV4 } = require('ai/test')

const model = new MockLanguageModelV4({
  provider: 'test-provider',
  modelId: 'test-model',
  doGenerate: async () => ({
    content: [{ type: 'text', text: 'bundled response' }],
    finishReason: { unified: 'stop', raw: undefined },
    usage: {
      inputTokens: { total: 2, noCache: 2 },
      outputTokens: { total: 2, text: 2 },
    },
    warnings: [],
  }),
})

generateText({ model, prompt: 'bundled prompt' }).catch(error => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
