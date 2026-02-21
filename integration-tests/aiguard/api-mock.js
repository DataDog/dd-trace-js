'use strict'

const express = require('express')

// TODO we could try to use cassettes instead of a mock for the AI Guard API
function startApiMock () {
  return new Promise((resolve, reject) => {
    try {
      const app = express()
      app.use(express.json())
      app.post('/evaluate', (req, res) => {
        const body = req.body
        const attributes = body?.data?.attributes
        if (!attributes?.messages || !attributes?.meta) {
          return res
            .status(400)
            .type('application/json')
            .json({
              errors: [
                {
                  status: '400',
                  title: 'Invalid data',
                  detail: 'Requests is missing messages and/or payload',
                },
              ],
            })
        }
        const messages = attributes.messages
        const lastMessage = messages[messages.length - 1]
        let action = 'ALLOW'
        let reason = 'The prompt looks harmless'

        // Check for tool_calls in assistant messages (for tool call evaluation)
        if (lastMessage.role === 'assistant' && lastMessage.tool_calls) {
          const toolCalls = lastMessage.tool_calls
          for (const toolCall of toolCalls) {
            const args = toolCall.function?.arguments || ''
            // Check if tool call arguments contain suspicious content
            if (args.includes('You should not trust me')) {
              action = 'DENY'
              reason = 'I am feeling suspicious today'
              break
            } else if (args.includes('Nuke yourself')) {
              action = 'ABORT'
              reason = 'The user is trying to destroy me'
              break
            }
          }
        } else {
          // Check content for prompt evaluation
          const content = lastMessage.content || ''
          if (content.startsWith('You should not trust me')) {
            action = 'DENY'
            reason = 'I am feeling suspicious today'
          } else if (content.startsWith('Nuke yourself')) {
            action = 'ABORT'
            reason = 'The user is trying to destroy me'
          }
        }

        // For DENY and ABORT actions, blocking is enabled by default
        // This simulates Datadog's is_blocking_enabled setting
        const isBlockingEnabled = action === 'DENY' || action === 'ABORT'

        res
          .status(200)
          .json({
            data: {
              attributes: {
                action,
                reason,
                is_blocking_enabled: isBlockingEnabled,
              },
            },
          })
      })
      const server = app.listen(() => {
        resolve(server)
      })
    } catch (e) {
      reject(e)
    }
  })
}

module.exports = startApiMock
