import { randomUUID } from 'node:crypto'

import { generateText, jsonSchema, tool } from 'ai'

const TOOL_CALL_COUNT = 10_000
// Make the leaked registry exceed the small test heap without requiring an impractically long load test.
const TOOL_CALL_ID_PADDING = 'x'.repeat(4_096)
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }

class RandomToolCallModel {
  specificationVersion = 'v2'
  provider = 'test'
  modelId = 'random-tool-call-model'
  supportedUrls = {}

  async doGenerate () {
    return {
      content: [{
        type: 'tool-call',
        toolCallId: `${randomUUID()}-${TOOL_CALL_ID_PADDING}`,
        toolName: 'noop',
        input: '{}',
      }],
      finishReason: 'tool-calls',
      usage,
      warnings: [],
    }
  }
}

const model = new RandomToolCallModel()
const tools = {
  noop: tool({
    description: 'Return without doing any work',
    inputSchema: jsonSchema({ type: 'object', properties: {}, additionalProperties: false }),
    execute: () => undefined,
  }),
}

for (let i = 0; i < TOOL_CALL_COUNT; i++) {
  await generateText({ model, prompt: 'Call the noop tool.', tools })
}
