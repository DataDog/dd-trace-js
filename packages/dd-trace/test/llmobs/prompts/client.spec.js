'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const { describe, it } = require('mocha')

const { PromptsClient } = require('../../../src/llmobs/prompts/client')

async function startServer (handler, options = {}) {
  const server = http.createServer(handler)
  await new Promise(resolve => {
    server.once('listening', resolve)
    server.listen({ port: 0, host: '127.0.0.1' })
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    server,
    client: new PromptsClient({
      apiKey: 'api',
      appKey: 'app',
      overrideOrigin: `http://127.0.0.1:${port}`,
      ...options,
    }),
  }
}

// Node 18's `server.close()` waits for idle keep-alive sockets held by the global fetch pool.
async function stopServer (server) {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}

describe('PromptsClient', () => {
  it('sends prompt requests with Datadog headers and normalizes IDs', async () => {
    const requests = []
    const { server, client } = await startServer((request, response) => {
      requests.push({ method: request.method, url: request.url, headers: request.headers })
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ ID: 'uuid', prompt_id: 'id', version: '1', template: 'Hi' }))
    })
    const result = await client.getPrompt({ id: 'hello world', label: 'prod' })
    assert.strictEqual(result.id, 'uuid')
    assert.strictEqual(requests[0].method, 'GET')
    assert.match(requests[0].url, /hello%20world/)
    assert.strictEqual(requests[0].headers['dd-api-key'], 'api')
    assert.strictEqual(requests[0].headers['dd-application-key'], 'app')
    await stopServer(server)
  })

  it('maps missing keys to PromptAPIError', async () => {
    const client = new PromptsClient()
    await assert.rejects(client.getPrompt({ id: 'id' }),
      error => error instanceof Error && 'status' in error && error.status === 401)
  })

  it('sends JSON API resolve bodies and omits absent selectors', async () => {
    let body = { data: { attributes: {} } }
    const { server, client } = await startServer(async (request, response) => {
      body = JSON.parse(await new Promise(resolve => {
        let data = ''
        request.on('data', chunk => { data += chunk })
        request.on('end', () => resolve(data))
      }))
      response.setHeader('content-type', 'application/json')
      response.end('{}')
    })
    await client.resolvePrompt({ id: 'id', env: 'prod' })
    assert.deepEqual(body, {
      data: { type: 'prompt_resolve_requests', attributes: { env: 'prod' } },
    })
    await stopServer(server)
  })

  it('sends targeting key and context when resolving', async () => {
    let body = { data: { attributes: {} } }
    const { server, client } = await startServer(async (request, response) => {
      body = JSON.parse(await new Promise(resolve => {
        let data = ''
        request.on('data', chunk => { data += chunk })
        request.on('end', () => resolve(data))
      }))
      response.end('{}')
    })
    await client.resolvePrompt({ id: 'id', env: 'prod', targetingKey: 'user', attributes: { tier: 'gold' } })
    assert.deepEqual(body.data.attributes, {
      env: 'prod',
      targeting_key: 'user',
      context: { tier: 'gold' },
    })
    await stopServer(server)
  })

  it('uses all CRUD paths and snake_case payloads', async () => {
    const requests = []
    const { server, client } = await startServer(async (request, response) => {
      let data = ''
      request.on('data', chunk => { data += chunk })
      request.on('end', () => {
        requests.push({ method: request.method, url: request.url, body: data && JSON.parse(data) })
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ id: 'response' }))
      })
    })
    await client.createPrompt({ prompt_id: 'id', template: 'hi', user_version: 'v1' })
    await client.createPromptVersion('id', { template: 'hi', env_ids: ['prod'] })
    await client.updatePrompt('id', { description: 'updated' })
    await client.updatePromptVersion('id', 2, { labels: ['prod'] })
    await client.deletePrompt('id')
    assert.deepEqual(requests.map(request => [request.method, request.url]), [
      ['POST', '/api/unstable/llm-obs/v1/prompts'],
      ['POST', '/api/unstable/llm-obs/v1/prompts/id/versions'],
      ['PATCH', '/api/unstable/llm-obs/v1/prompts/id'],
      ['PATCH', '/api/unstable/llm-obs/v1/prompts/id/versions/2'],
      ['DELETE', '/api/unstable/llm-obs/v1/prompts/id'],
    ])
    assert.deepEqual(requests[0].body, { prompt_id: 'id', template: 'hi', user_version: 'v1' })
    await stopServer(server)
  })

  it('lists prompts and versions without query parameters', async () => {
    const urls = []
    const { server, client } = await startServer((request, response) => {
      urls.push(request.url)
      response.setHeader('content-type', 'application/json')
      response.end('[]')
    })
    await client.listPrompts()
    await client.listPromptVersions('id')
    assert.deepEqual(urls, [
      '/api/unstable/llm-obs/v1/prompts',
      '/api/unstable/llm-obs/v1/prompts/id/versions',
    ])
    await stopServer(server)
  })

  it('gates resolve and writes on app key', async () => {
    const { server, client } = await startServer((request, response) => response.end('[]'), { appKey: undefined })
    await assert.rejects(client.resolvePrompt({ id: 'id', env: 'prod' }),
      error => error instanceof Error && 'status' in error && error.status === 403)
    await assert.rejects(client.createPrompt({ prompt_id: 'id', template: 'x' }),
      error => error instanceof Error && 'status' in error && error.status === 403)
    await assert.doesNotReject(client.listPrompts())
    await stopServer(server)
  })

  it('normalizes empty success bodies', async () => {
    const { server, client } = await startServer((request, response) => response.end())
    assert.deepEqual(await client.deletePrompt('id'), {})
    await stopServer(server)
  })

  it('reports API status and detail for HTTP failures', async () => {
    for (const status of [400, 401, 403, 404, 409, 500]) {
      const { server, client } = await startServer((request, response) => {
        response.statusCode = status
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ detail: `status ${status}` }))
      })
      await assert.rejects(client.getPrompt({ id: 'id' }), error => {
        if (!(error instanceof Error) || !('status' in error)) return false
        if (!('detail' in error)) return false
        assert.strictEqual(error.status, status)
        assert.strictEqual(error.detail, `status ${status}`)
        return true
      })
      await stopServer(server)
    }
  })

  it('reports transport errors with status zero', async () => {
    const client = new PromptsClient({ apiKey: 'api', overrideOrigin: 'http://127.0.0.1:1' })
    await assert.rejects(client.getPrompt({ id: 'id' }),
      error => error instanceof Error && 'status' in error && error.status === 0)
  })

  it('normalizes IDs in list responses', async () => {
    const { server, client } = await startServer((request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify([{ ID: 'uuid', prompt_id: 'id' }]))
    })
    assert.deepEqual(await client.listPrompts(), [{ ID: 'uuid', prompt_id: 'id', id: 'uuid' }])
    await stopServer(server)
  })

  it('reports malformed JSON success bodies', async () => {
    const { server, client } = await startServer((request, response) => response.end('not json'))
    await assert.rejects(client.getPrompt({ id: 'id' }),
      error => error instanceof Error && 'status' in error && error.status === 200)
    await stopServer(server)
  })

  it('encodes IDs and query labels', async () => {
    /** @type {string | undefined} */
    let url
    const { server, client } = await startServer((request, response) => {
      url = request.url
      response.end('{}')
    })
    await client.getPrompt({ id: 'hello world/1', label: 'production' })
    assert.strictEqual(url, '/api/unstable/llm-obs/v1/prompts/hello%20world%2F1?label=production')
    await stopServer(server)
  })

  it('uses configured request timeouts', async () => {
    const { server, client } = await startServer(() => {}, { timeout: 1 })
    await assert.rejects(client.getPrompt({ id: 'id' }),
      error => error instanceof Error && 'status' in error && error.status === 0)
    await stopServer(server)
  })
})
