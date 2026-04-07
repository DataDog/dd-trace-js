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

        // Extract text content from the last message regardless of type
        const content = extractContent(lastMessage)

        if (content.startsWith('You should not trust me')) {
          action = 'DENY'
          reason = 'I am feeling suspicious today'
        } else if (content.startsWith('Nuke yourself')) {
          action = 'ABORT'
          reason = 'The user is trying to destroy me'
        }
        let blocking = content.endsWith('[block]')

        // Check all messages for DENY marker
        for (const msg of messages) {
          const msgContent = extractContent(msg)
          if (msgContent.includes('[deny]')) {
            action = 'DENY'
            reason = 'Blocked by policy'
            blocking = true
            break
          }
        }

        res
          .status(200)
          .json({
            data: {
              attributes: {
                action,
                reason,
                is_blocking_enabled: blocking,
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

function extractContent (message) {
  if (typeof message.content === 'string') return message.content
  if (message.tool_calls) {
    return message.tool_calls.map(tc => tc.function?.arguments || '').join(' ')
  }
  return ''
}

module.exports = startApiMock
