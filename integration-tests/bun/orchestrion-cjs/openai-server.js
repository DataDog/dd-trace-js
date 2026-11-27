'use strict'

const http = require('node:http')

/**
 * Start a local server answering every request with an OpenAI chat completion.
 *
 * @returns {Promise<{ baseURL: string, server: http.Server }>}
 */
function startOpenAIServer () {
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        id: 'chatcmpl-bun',
        object: 'chat.completion',
        created: 0,
        model: 'gpt-4o-mini',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }))
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = /** @type {import('node:net').AddressInfo} */ (server.address())
      resolve({ baseURL: `http://127.0.0.1:${address.port}/v1`, server })
    })
  })
}

module.exports = startOpenAIServer
