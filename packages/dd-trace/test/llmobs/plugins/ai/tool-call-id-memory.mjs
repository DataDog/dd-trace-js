import { randomUUID } from 'node:crypto'

import { generateText, jsonSchema, tool } from 'ai'

const TOOL_CALL_COUNT = 10_000
// Make the leaked registry exceed the small test heap without requiring an impractically long load test.
const TOOL_CALL_ID_PADDING = 'x'.repeat(4_096)
const specificationVersion = process.env.AI_MODEL_SPECIFICATION_VERSION
const v2Usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
const v3Usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 0, reasoning: 0 },
}

class RandomToolCallModel {
  specificationVersion = specificationVersion
  provider = 'test'
  modelId = 'random-tool-call-model'
  supportedUrls = {}

  async doGenerate (options) {
    const toolCallId = `${randomUUID()}-${TOOL_CALL_ID_PADDING}`
    const toolName = specificationVersion === 'v1' ? options.mode.tools[0].name : options.tools[0].name

    if (specificationVersion === 'v1') {
      return {
        toolCalls: [{
          toolCallType: 'function',
          toolCallId,
          toolName,
          args: '{}',
        }],
        finishReason: 'tool-calls',
        usage: { promptTokens: 1, completionTokens: 1 },
        rawCall: { rawPrompt: null, rawSettings: {} },
        warnings: [],
      }
    }

    return {
      content: [{
        type: 'tool-call',
        toolCallId,
        toolName,
        input: '{}',
      }],
      finishReason: specificationVersion === 'v3'
        ? { unified: 'tool-calls', raw: 'tool-calls' }
        : 'tool-calls',
      usage: specificationVersion === 'v3' ? v3Usage : v2Usage,
      warnings: [],
    }
  }
}

const model = new RandomToolCallModel()
const schema = jsonSchema({ type: 'object', properties: {}, additionalProperties: false })

for (let i = 0; i < TOOL_CALL_COUNT; i++) {
  await generateText({
    model,
    prompt: 'Call the noop tool.',
    tools: specificationVersion === 'v1'
      ? [
          tool({
            description: 'Return without doing any work',
            ...(specificationVersion === 'v1'
              ? { id: 'noop', parameters: schema }
              : { inputSchema: schema }),
            execute: () => undefined,
          }),
        ]
      : {
          noop: tool({
            description: 'Return without doing any work',
            ...(specificationVersion === 'v1'
              ? { id: 'noop', parameters: schema }
              : { inputSchema: schema }),
            execute: () => undefined,
          }),
        },
  })
}
