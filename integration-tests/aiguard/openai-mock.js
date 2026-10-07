'use strict'

const express = require('express')

/**
 * Minimal OpenAI-compatible mock for integration tests. Serves `/v1/chat/completions`
 * and `/v1/responses` with canned responses. The mock inspects `req.body` to pick
 * the response shape (streaming, tool-call, deny-marker), but it does NOT make any
 * AI Guard decisions itself — the AI Guard verdict comes from the separate AI Guard
 * API mock, which recognizes the `[deny]` marker the tests inject into user prompts.
 */
function startOpenAIMock () {
  return new Promise(resolve => {
    const app = express()
    app.use(express.json({ limit: '1mb' }))

    app.post('/v1/chat/completions', (req, res) => {
      const model = req.body?.model ?? 'gpt-4o-mini'
      const wantsToolCall = req.body?.messages?.some(m => m.content?.includes?.('use tool'))
      const denyResponse = req.body?.metadata?.mock_response === 'deny'

      // Streaming branch: emit either text or split tool-call deltas followed by [DONE].
      if (req.body?.stream) {
        res.status(200)
          .set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          })
        const id = 'chatcmpl-mock'
        const created = Math.floor(Date.now() / 1000)
        const send = chunk => res.write(`data: ${JSON.stringify(chunk)}\n\n`)
        const chunkBase = { id, object: 'chat.completion.chunk', created, model }

        if (wantsToolCall) {
          send({
            ...chunkBase,
            choices: [{
              index: 0,
              delta: {
                role: 'assistant',
                content: null,
                tool_calls: [{
                  index: 0,
                  id: 'call_mock',
                  type: 'function',
                  function: { name: 'search', arguments: '' },
                }],
              },
              finish_reason: null,
            }],
          })
          send({
            ...chunkBase,
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: 0,
                  function: { arguments: denyResponse ? '{"q":"[deny]"}' : '{"q":"example"}' },
                }],
              },
              finish_reason: null,
            }],
          })
          send({
            ...chunkBase,
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          })
          res.write('data: [DONE]\n\n')
          return res.end()
        }

        send({
          ...chunkBase,
          choices: [{
            index: 0,
            delta: { role: 'assistant', content: denyResponse ? 'Unsafe streamed output ' : 'Hello' },
            finish_reason: null,
          }],
        })
        send({
          ...chunkBase,
          choices: [{
            index: 0,
            delta: { content: denyResponse ? '[deny]' : ' world' },
            finish_reason: null,
          }],
        })
        send({
          ...chunkBase,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })
        res.write('data: [DONE]\n\n')
        return res.end()
      }

      // Structured-output (`.parse()`) requests carry a `json_schema` response_format and route
      // through the SDK's lazy `_thenUnwrap`/`parse` path, which JSON-parses `message.content`.
      // Keep the content valid JSON while still carrying the `[deny]` marker the AI Guard mock
      // recognizes for the After Model verdict.
      const structured = req.body?.response_format?.type === 'json_schema'

      let message
      if (wantsToolCall) {
        message = {
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
      } else if (structured) {
        const greeting = denyResponse ? 'Unsafe structured output [deny]' : 'Hello from the structured mock!'
        message = { role: 'assistant', content: JSON.stringify({ greeting }), refusal: null }
      } else {
        message = { role: 'assistant', content: denyResponse ? 'Unsafe mock response [deny]' : 'Hello from the mock!' }
      }

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
      const response = {
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
      }

      if (req.body?.stream) {
        res.status(200)
          .set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          })
        const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        send('response.created', {
          type: 'response.created',
          response: { ...response, status: 'in_progress', output: [], usage: null },
          sequence_number: 0,
        })
        send('response.completed', {
          type: 'response.completed',
          response,
          sequence_number: 1,
        })
        return res.end()
      }

      res.status(200).json(response)
    })

    const server = app.listen(() => resolve(server))
  })
}

module.exports = startOpenAIMock
