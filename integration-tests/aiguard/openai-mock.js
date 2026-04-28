'use strict'

const express = require('express')

/**
 * Minimal OpenAI-compatible mock for integration tests. Serves `/v1/chat/completions`
 * and `/v1/responses` with canned responses. Does NOT inspect the request body — the
 * AI Guard action is driven by the separate AI Guard API mock, which recognizes the
 * `[deny]` marker the tests inject into user prompts.
 */
function startOpenAIMock () {
  return new Promise(resolve => {
    const app = express()
    app.use(express.json({ limit: '1mb' }))

    app.post('/v1/chat/completions', (req, res) => {
      const model = req.body?.model ?? 'gpt-4o-mini'
      const wantsToolCall = req.body?.messages?.some(m => m.content?.includes?.('use tool'))
      const denyResponse = req.body?.metadata?.mock_response === 'deny'
      const message = wantsToolCall
        ? {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_mock',
              type: 'function',
              function: {
                name: 'search',
                arguments: '{"q":"example"}',
              },
            }],
          }
        : { role: 'assistant', content: denyResponse ? 'Unsafe mock response [deny]' : 'Hello from the mock!' }

      res.status(200).json({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          message,
          finish_reason: wantsToolCall ? 'tool_calls' : 'stop',
        }],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
      })
    })

    app.post('/v1/responses', (req, res) => {
      const model = req.body?.model ?? 'gpt-4o-mini'
      const text = req.body?.metadata?.mock_response === 'deny'
        ? 'Unsafe mock responses output [deny]'
        : 'Hello from mock responses!'
      res.status(200).json({
        id: 'resp_mock',
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        status: 'completed',
        model,
        output: [{
          id: 'msg_mock',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }],
        }],
        usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
      })
    })

    const server = app.listen(() => resolve(server))
  })
}

module.exports = startOpenAIMock
