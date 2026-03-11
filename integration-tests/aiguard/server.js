'use strict'

const tracer = require('dd-trace').init({ flushInterval: 0 })
const express = require('express')
const ai = require('ai')
const { generateText, jsonSchema, stepCountIs, streamText, tool } = ai

const app = express()
const MOCK_USAGE = { inputTokens: 10, outputTokens: 20, totalTokens: 30 }

function getPromptText (prompt) {
  const lastMessage = prompt[prompt.length - 1]
  if (!lastMessage?.content) {
    return ''
  }
  if (typeof lastMessage.content === 'string') {
    return lastMessage.content
  }
  if (Array.isArray(lastMessage.content)) {
    const textPart = lastMessage.content.find(p => p.type === 'text')
    return textPart?.text || ''
  }
  return ''
}

function createGenerateTextModel (specificationVersion = 'v3') {
  return {
    specificationVersion,
    provider: 'mock',
    modelId: 'mock-model',
    doGenerate: async ({ prompt }) => {
      const promptText = getPromptText(prompt)

      return {
        content: [{ type: 'text', text: `Mock response to: ${promptText}` }],
        finishReason: 'stop',
        usage: MOCK_USAGE,
        request: {},
        response: { id: 'mock-response-id', timestamp: new Date(), modelId: 'mock-model' },
        warnings: [],
      }
    },
  }
}

function createBlockedToolCallStreamModel () {
  return {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock-model',
    doStream: async () => {
      const stream = new ReadableStream({
        start (controller) {
          controller.enqueue({
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'dangerousOp',
            input: '{"command":"You should not trust me"}',
          })
          controller.enqueue({
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: undefined },
            usage: MOCK_USAGE,
          })
          controller.close()
        },
      })

      return {
        stream,
        request: {},
        response: { id: 'mock-stream-response-id', timestamp: new Date(), modelId: 'mock-model' },
        warnings: [],
      }
    },
  }
}

// SDK direct evaluation endpoints
app.get('/allow', async (req, res) => {
  const evaluation = await tracer.aiguard.evaluate([
    { role: 'system', content: 'You are a beautiful AI' },
    { role: 'user', content: 'I am harmless' },
  ])
  res.status(200).json(evaluation)
})

app.get('/deny', async (req, res) => {
  const block = req.headers['x-blocking-enabled'] === 'true'
  try {
    const evaluation = await tracer.aiguard.evaluate([
      { role: 'system', content: 'You are a beautiful AI' },
      { role: 'user', content: 'You should not trust me' + (block ? ' [block]' : '') },
    ], { block })
    res.status(200).json(evaluation)
  } catch (error) {
    if (error.name === 'AIGuardAbortError') {
      res.status(403).send(error.reason)
    } else {
      res.status(500).send('Internal Server Error')
    }
  }
})

app.get('/abort', async (req, res) => {
  const block = req.headers['x-blocking-enabled'] === 'true'
  try {
    const evaluation = await tracer.aiguard.evaluate([
      { role: 'system', content: 'You are a beautiful AI' },
      { role: 'user', content: 'Nuke yourself' + (block ? ' [block]' : '') },
    ], { block })
    res.status(200).json(evaluation)
  } catch (error) {
    if (error.name === 'AIGuardAbortError') {
      res.status(403).send(error.reason)
    } else {
      res.status(500).send('Internal Server Error')
    }
  }
})

function createToolOptions (executionState) {
  const schema = jsonSchema({
    type: 'object',
    properties: {
      command: { type: 'string' },
    },
    required: ['command'],
  })
  const execute = async ({ command }) => {
    executionState.toolExecuted = true
    return { command, ok: true }
  }

  if (typeof stepCountIs === 'function') {
    return {
      tools: {
        dangerousOp: tool({
          description: 'Execute a dangerous operation',
          inputSchema: schema,
          execute,
        }),
      },
      additionalOptions: {
        stopWhen: stepCountIs(3),
      },
    }
  }

  return {
    tools: [tool({
      id: 'dangerousOp',
      description: 'Execute a dangerous operation',
      parameters: schema,
      execute,
    })],
    additionalOptions: {
      maxSteps: 3,
    },
  }
}

function toPublicError (error) {
  return {
    error: error?.message ?? String(error),
    hasCause: !!error?.cause,
  }
}

// Direct instrumentation + Vercel AI SDK endpoints
app.get('/instrumentation/prompt/allow', async (req, res) => {
  try {
    const result = await generateText({
      model: createGenerateTextModel(),
      prompt: 'I am harmless',
    })
    res.status(200).json({ text: result.text })
  } catch (error) {
    res.status(403).json({ error: error.message })
  }
})

app.get('/instrumentation/stream/tool-deny', async (req, res) => {
  const executionState = { toolExecuted: false }

  try {
    const { tools, additionalOptions } = createToolOptions(executionState)
    const result = await streamText({
      model: createBlockedToolCallStreamModel(),
      prompt: 'I am harmless',
      tools,
      ...additionalOptions,
    })

    const chunks = []
    for await (const chunk of result.fullStream) {
      chunks.push(chunk)
      if (chunk.type === 'error') {
        res.status(403).json({
          chunks,
          toolExecuted: executionState.toolExecuted,
          ...toPublicError(chunk.error),
        })
        return
      }
    }
    res.status(200).json({ chunks, toolExecuted: executionState.toolExecuted })
  } catch (error) {
    res.status(403).json({
      toolExecuted: executionState.toolExecuted,
      ...toPublicError(error),
    })
  }
})

app.get('/instrumentation/v2-model', async (req, res) => {
  try {
    const result = await generateText({
      model: createGenerateTextModel('v2'),
      prompt: 'I am harmless',
    })

    res.status(200).json({ text: result.text })
  } catch (error) {
    res.status(403).json({ error: error.message })
  }
})

const server = app.listen(() => {
  const port = (/** @type {import('net').AddressInfo} */ (server.address())).port
  process.send({ port })
})
