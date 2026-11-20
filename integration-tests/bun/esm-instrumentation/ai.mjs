import { generateText } from 'ai'
import { MockLanguageModelV2 } from 'ai/test'

import finish from '../finish.js'

const model = new MockLanguageModelV2({
  doGenerate: async () => ({
    finishReason: 'stop',
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    content: [{ type: 'text', text: 'Hello from Bun' }],
    warnings: [],
  }),
})

await generateText({ model, prompt: 'Hello' })

finish()
