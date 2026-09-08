'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const { describe, it } = require('mocha')

const { PromptsClient } = require('../../../src/llmobs/prompts/client')

describe('PromptsClient', () => {
  it('sends prompt requests with Datadog headers and normalizes IDs', async () => {
    const requests = []
    const server = http.createServer((request, response) => {
      requests.push({ method: request.method, url: request.url, headers: request.headers })
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ ID: 'uuid', prompt_id: 'id', version: '1', template: 'Hi' }))
    })
    await new Promise(resolve => {
      server.once('listening', resolve)
      server.listen({ port: 0, host: '127.0.0.1' })
    })
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const client = new PromptsClient({
      apiKey: 'api',
      appKey: 'app',
      overrideOrigin: `http://127.0.0.1:${port}`,
    })
    const result = await client.getPrompt({ id: 'hello world', label: 'prod' })
    assert.strictEqual(result.id, 'uuid')
    assert.strictEqual(requests[0].method, 'GET')
    assert.match(requests[0].url, /hello%20world/)
    assert.strictEqual(requests[0].headers['dd-api-key'], 'api')
    assert.strictEqual(requests[0].headers['dd-application-key'], 'app')
    await new Promise(resolve => server.close(resolve))
  })

  it('maps missing keys to PromptAPIError', async () => {
    const client = new PromptsClient()
    await assert.rejects(client.getPrompt({ id: 'id' }),
      error => error instanceof Error && 'status' in error && error.status === 401)
  })
})
