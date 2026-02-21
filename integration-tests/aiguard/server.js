'use strict'

const tracer = require('dd-trace').init({ flushInterval: 0 })
const express = require('express')
const { generateText, streamText, wrapLanguageModel } = require('ai')
const { AIGuardMiddleware } = tracer

const app = express()
app.use(express.json())

// Helper functions for Vercel AI SDK integration
function getLastMessageText (prompt) {
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

function createMockModel (options = {}) {
  const { toolCalls = [] } = options

  return {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock-model',
    defaultObjectGenerationMode: 'json',

    doGenerate: async ({ prompt }) => {
      const textContent = getLastMessageText(prompt)
      const content = [{ type: 'text', text: `Mock response to: ${textContent}` }]

      for (const tc of toolCalls) {
        content.push({
          type: 'tool-call',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: tc.args
        })
      }

      return {
        content,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        request: {},
        response: { id: 'mock-response-id', timestamp: new Date(), modelId: 'mock-model' }
      }
    },

    doStream: async ({ prompt }) => {
      const textContent = getLastMessageText(prompt)
      const responseText = `Mock streamed response to: ${textContent}`
      const chunks = []

      for (const char of responseText) {
        chunks.push({ type: 'text-delta', delta: char })
      }

      for (const tc of toolCalls) {
        chunks.push({
          type: 'tool-call',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: tc.args
        })
      }

      chunks.push({
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }
      })

      const stream = new ReadableStream({
        start (controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk)
          }
          controller.close()
        }
      })

      return {
        stream,
        request: {},
        response: { id: 'mock-stream-response-id', timestamp: new Date(), modelId: 'mock-model' }
      }
    }
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

// AIGuardMiddleware + Vercel AI SDK endpoints
app.get('/middleware/prompt/allow', async (req, res) => {
  try {
    const model = wrapLanguageModel({
      model: createMockModel(),
      middleware: new AIGuardMiddleware({ tracer })
    })
    const result = await generateText({ model, prompt: 'I am harmless' })
    res.status(200).json({ text: result.text })
  } catch (error) {
    res.status(403).json({ error: error.message, code: error.code })
  }
})

app.get('/middleware/stream/tool-deny', async (req, res) => {
  try {
    const model = wrapLanguageModel({
      model: createMockModel({
        toolCalls: [{
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'dangerousOp',
          args: { command: 'You should not trust me' }
        }]
      }),
      middleware: new AIGuardMiddleware({ tracer })
    })
    const result = await streamText({ model, prompt: 'I am harmless' })

    const chunks = []
    for await (const chunk of result.fullStream) {
      chunks.push(chunk)
      if (chunk.type === 'error') {
        res.status(403).json({ error: chunk.error.message, chunks })
        return
      }
    }
    res.status(200).json({ chunks })
  } catch (error) {
    res.status(403).json({ error: error.message, code: error.code })
  }
})

const server = app.listen(() => {
  const port = (/** @type {import('net').AddressInfo} */ (server.address())).port
  process.send({ port })
})
