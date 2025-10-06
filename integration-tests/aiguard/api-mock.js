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
                }
              ]
            })
        }
        const messages = attributes.messages
        const lastMessage = messages[messages.length - 1]
        let action = 'ALLOW'
        let reason = 'The prompt looks harmless'
        if (lastMessage.content.startsWith('You should not trust me')) {
          action = 'DENY'
          reason = 'I am feeling suspicious today'
        } else if (lastMessage.content.startsWith('Nuke yourself')) {
          action = 'ABORT'
          reason = 'The user is trying to destroy me'
        }
        const blocking = lastMessage.content.endsWith('[block]')

        res
          .status(200)
          .json({
            data: {
              attributes: {
                action,
                reason,
                is_blocking_enabled: blocking,
              }
            }
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
