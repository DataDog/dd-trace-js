import { createServer } from 'node:http'

import {
  generateText,
  isStepCount,
  jsonSchema,
  streamText,
  tool,
  ToolLoopAgent,
  wrapLanguageModel,
} from 'ai'
import { MockLanguageModelV4 } from 'ai/test'

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}

const server = createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost')
  let text = ''
  let toolExecutions = 0
  let error

  /** @param {Array<object>} prompt */
  function result (prompt) {
    const mixed = searchParams.has('mixed') && !prompt.some(message => message.role === 'tool')
    const content = [{
      type: 'text',
      text: mixed ? (searchParams.get('deny') === 'text' ? '[deny] unsafe text' : 'Looking up') : 'Hello',
    }]
    if (mixed) {
      content.push({
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'lookup',
        input: JSON.stringify({ query: searchParams.get('deny') === 'tool' ? '[deny]' : 'safe' }),
      })
    }
    return { content, usage, warnings: [], finishReason: { unified: mixed ? 'tool-calls' : 'stop' } }
  }

  const model = new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => result(prompt),
    doStream: async ({ prompt }) => {
      const generated = result(prompt)
      const chunks = [{ type: 'stream-start', warnings: [] }]
      for (const part of generated.content) {
        if (part.type === 'tool-call') chunks.push(part)
        else {
          chunks.push(
            { type: 'text-start', id: 'text_1' },
            { type: 'text-delta', id: 'text_1', delta: part.text },
            { type: 'text-end', id: 'text_1' },
          )
        }
      }
      chunks.push({ type: 'finish', usage, finishReason: generated.finishReason })
      return {
        stream: new ReadableStream({
          start (controller) {
            for (const chunk of chunks) controller.enqueue(chunk)
            controller.close()
          },
        }),
      }
    },
  })
  const tools = {
    lookup: tool({
      inputSchema: jsonSchema({ type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }),
      execute: async () => {
        toolExecutions++
        return 'safe tool result'
      },
    }),
  }
  const options = { model, prompt: 'Hello', tools, maxRetries: 0, onError () {} }
  if (searchParams.has('image')) {
    options.prompt = [{
      role: 'user',
      content: [{
        type: 'file',
        mediaType: 'image/png',
        data: new Uint8Array([1, 2, 3]),
      }],
    }]
  }

  try {
    if (pathname === '/generate') {
      text = (await generateText(options)).text
    } else {
      let output
      if (pathname === '/agent') {
        const agent = new ToolLoopAgent({
          model: wrapLanguageModel({ model, middleware: { specificationVersion: 'v4' } }),
          tools,
          maxRetries: 0,
          stopWhen: isStepCount(2),
          onError () {},
        })
        output = await agent.stream({ prompt: options.prompt })
      } else {
        output = streamText(options)
      }
      for await (const chunk of output.fullStream) {
        if (chunk.type === 'error') throw chunk.error
        if (chunk.type === 'text-delta') text += chunk.text
      }
    }
  } catch (err) {
    error = { name: err.name, message: err.message }
  }
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ text, toolExecutions, error }))
})
server.listen(0, () => process.send({ port: server.address().port }))
