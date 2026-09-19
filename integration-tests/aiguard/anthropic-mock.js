'use strict'

const express = require('express')

function startAnthropicMock () {
  return new Promise(resolve => {
    const app = express()
    app.use(express.json({ limit: '1mb' }))

    app.post('/v1/messages', (req, res) => {
      const model = req.body?.model ?? 'claude-haiku-4-5'
      const wantsToolCall = req.body?.messages?.some(message => message.content?.includes?.('use tool'))
      const denyResponse = req.headers['x-mock-response'] === 'deny'

      res.status(200).set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })

      const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      send({
        type: 'message_start',
        message: {
          id: 'msg_mock',
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 8, output_tokens: 1 },
        },
      })

      if (wantsToolCall) {
        send({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tool_mock', name: 'search', input: {} },
        })
        send({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"q":' },
        })
        send({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: denyResponse ? '"[deny]"}' : '"example"}' },
        })
        send({ type: 'content_block_stop', index: 0 })
      } else {
        send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        send({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: denyResponse ? 'Unsafe streamed output ' : 'Hello' },
        })
        send({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: denyResponse ? '[deny]' : ' world' },
        })
        send({ type: 'content_block_stop', index: 0 })
      }

      send({
        type: 'message_delta',
        delta: { stop_reason: wantsToolCall ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: 4 },
      })
      send({ type: 'message_stop' })
      res.end()
    })

    const server = app.listen(() => resolve(server))
  })
}

module.exports = startAnthropicMock
