'use strict'

const express = require('express')

// TODO we could try to use cassettes instead of a mock for the AI Guard API
function startApiMock () {
  return new Promise((resolve, reject) => {
    try {
      const app = express()
      const requests = []
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
        requests.push({ messages })
        const decision = getDecisionForMessage(messages[messages.length - 1])

        // For DENY and ABORT actions, blocking is enabled by default
        // This simulates Datadog's is_blocking_enabled setting
        const isBlockingEnabled = decision.action !== 'ALLOW'

        res
          .status(200)
          .json({
            data: {
              attributes: {
                action: decision.action,
                reason: decision.reason,
                is_blocking_enabled: isBlockingEnabled,
              },
            },
          })
      })
      const server = app.listen(() => {
        resolve(server)
      })

      server.getRequests = function () {
        return requests.slice()
      }

      server.resetRequests = function () {
        requests.length = 0
      }
    } catch (e) {
      reject(e)
    }
  })
}

function getDecisionForMessage (message) {
  if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      const decision = getDecisionForText(toolCall.function?.arguments ?? '')
      if (decision.action !== 'ALLOW') {
        return decision
      }
    }
  }

  return getDecisionForText(message?.content ?? '')
}

function getDecisionForText (text) {
  if (text.includes('You should not trust me')) {
    return {
      action: 'DENY',
      reason: 'I am feeling suspicious today',
    }
  }

  if (text.includes('Nuke yourself')) {
    return {
      action: 'ABORT',
      reason: 'The user is trying to destroy me',
    }
  }

  return {
    action: 'ALLOW',
    reason: 'The prompt looks harmless',
  }
}

module.exports = startApiMock
