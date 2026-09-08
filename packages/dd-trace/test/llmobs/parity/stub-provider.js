'use strict'

const http = require('node:http')
const { URL } = require('node:url')

/**
 * @param {object} fixture
 * @param {Array<object>} fixture.responses
 * @returns {{ server: import('node:http').Server, port: () => number, close: () => Promise<void> }}
 */
function createStubProvider (fixture) {
  const queues = new Map()
  for (const response of fixture.responses ?? []) {
    const key = `${response.match.method.toUpperCase()} ${response.match.path}`
    const queue = queues.get(key) ?? []
    queue.push(response)
    queues.set(key, queue)
  }

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
    const key = `${req.method?.toUpperCase()} ${requestUrl.pathname}`
    const queue = queues.get(key)
    const response = queue?.shift()

    if (!response) {
      const summary = `${req.method} ${requestUrl.pathname}${requestUrl.search}`
      process.stderr.write(`stub-provider unmatched request: ${summary}\n`)
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unmatched stub request', request: summary }))
      return
    }

    const body = typeof response.body === 'string' ? response.body : JSON.stringify(response.body)
    const headers = {
      'content-type': response.stream ? 'text/event-stream' : 'application/json',
      ...response.headers,
    }
    res.writeHead(response.status ?? 200, headers)
    res.end(body)
  })

  return {
    server,
    port: () => {
      const address = server.address()
      return typeof address === 'object' && address ? address.port : 0
    },
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}

async function startStubProvider (fixture) {
  const provider = createStubProvider(fixture)
  await new Promise((resolve, reject) => {
    provider.server.once('error', reject)
    provider.server.listen(0, '127.0.0.1', resolve)
  })
  return provider
}

module.exports = { createStubProvider, startStubProvider }
