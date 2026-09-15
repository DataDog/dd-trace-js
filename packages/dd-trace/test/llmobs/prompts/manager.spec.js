'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const { describe, it } = require('mocha')
const sinon = require('sinon')

const { PromptManager } = require('../../../src/llmobs/prompts/manager')
const { PromptsClient } = require('../../../src/llmobs/prompts/client')
const log = require('../../../src/log')

function getPort (server) {
  const address = server.address()
  return typeof address === 'object' && address ? address.port : 0
}

describe('PromptManager', () => {
  it('deduplicates registry requests and caches the result', async () => {
    let calls = 0
    const manager = new PromptManager({
      client: {
        getPrompt: async () => {
          calls++
          return { prompt_id: 'id', version: '1', template: 'Hi' }
        },
        appKey: 'app',
      },
    })
    const [first, second] = await Promise.all([manager.get('id'), manager.get('id')])
    assert.strictEqual(first, second)
    assert.strictEqual(calls, 1)
    assert.strictEqual((await manager.get('id')).render(), 'Hi')
  })

  it('uses lazy fallbacks when resolution cannot use an app key', async () => {
    let called = false
    const manager = new PromptManager({
      env: 'prod',
      client: { appKey: undefined, resolvePrompt: async () => { throw new Error('must not call') } },
    })
    const prompt = await manager.get('id', { fallback: () => { called = true; return 'fallback' } })
    assert.strictEqual(called, true)
    assert.strictEqual(prompt.source, 'fallback')
  })

  it('routes environments to resolve and versions to the version path', async () => {
    const calls = []
    const manager = new PromptManager({
      env: 'prod',
      client: {
        appKey: 'app',
        resolvePrompt: async options => {
          calls.push(['resolve', options])
          return { prompt_id: 'id', version: 1, template: 'resolved' }
        },
        getPrompt: async options => {
          calls.push(['get', options])
          return { prompt_id: 'id', version: 2, template: 'versioned' }
        },
      },
    })
    assert.strictEqual((await manager.get('id')).render(), 'resolved')
    assert.strictEqual((await manager.get('id', { version: 2, env: 'other' })).render(), 'versioned')
    assert.deepEqual(calls, [
      ['resolve', { id: 'id', env: 'prod', targetingKey: undefined, attributes: undefined }],
      ['get', { id: 'id', version: 2, label: undefined }],
    ])
  })

  it('warns when selectors conflict and gives version precedence', async () => {
    const warn = sinon.stub(log, 'warn')
    try {
      const manager = new PromptManager({
        client: {
          appKey: 'app',
          getPrompt: async options => ({ prompt_id: 'id', version: options.version, template: 'x' }),
        },
      })
      await manager.get('id', {
        version: 2,
        label: 'prod',
        targetingKey: 'user',
        attributes: { tier: 'gold' },
      })
      assert.strictEqual(warn.calledOnce, true)
      assert.match(warn.firstCall.args[0], /version/)
    } finally {
      warn.restore()
    }
  })

  it('warns when labels conflict with targeting selectors', async () => {
    const warn = sinon.stub(log, 'warn')
    try {
      const manager = new PromptManager({
        client: {
          appKey: 'app',
          getPrompt: async options => ({ prompt_id: 'id', version: 1, template: options.label }),
        },
      })
      await manager.get('id', { label: 'prod', targetingKey: 'user' })
      assert.strictEqual(warn.calledOnce, true)
      assert.match(warn.firstCall.args[0], /label/)
    } finally {
      warn.restore()
    }
  })

  it('evicts cache entries after every successful write', async () => {
    let reads = 0
    const client = {
      appKey: 'app',
      getPrompt: async () => {
        reads++
        return { prompt_id: 'id', version: reads, template: String(reads) }
      },
      createPrompt: async body => body,
      createPromptVersion: async (id, body) => body,
      updatePrompt: async (id, body) => body,
      updatePromptVersion: async (id, version, body) => body,
      deletePrompt: async () => ({ prompt_id: 'id' }),
    }
    const manager = new PromptManager({ client })
    await manager.get('id')
    await manager.create({ id: 'id', template: 'new' })
    await manager.get('id')
    await manager.createVersion('id', { template: 'new' })
    await manager.get('id')
    await manager.update('id', { title: 'new' })
    await manager.get('id')
    await manager.updateVersion('id', 1, { description: 'new' })
    await manager.get('id')
    await manager.delete('id')
    await manager.get('id')
    assert.strictEqual(reads, 6)
  })

  it('builds Python-shaped write payloads and returns delete responses', async () => {
    const calls = []
    const manager = new PromptManager({
      client: {
        appKey: 'app',
        createPrompt: async body => {
          calls.push(body)
          return body
        },
        createPromptVersion: async (id, body) => {
          calls.push(body)
          return body
        },
        updatePrompt: async (id, body) => {
          calls.push(body)
          return body
        },
        updatePromptVersion: async (id, version, body) => {
          calls.push(body)
          return body
        },
        deletePrompt: async () => ({ id: 'deleted' }),
      },
    })
    assert.deepEqual(await manager.create({
      id: 'id',
      template: 'hi',
      title: 'title',
      userVersion: 'v1',
      envIds: ['prod'],
    }), {
      prompt_id: 'id',
      template: 'hi',
      title: 'title',
      user_version: 'v1',
      env_ids: ['prod'],
    })
    await manager.createVersion('id', { template: 'v2', labels: ['prod'] })
    await manager.update('id', { description: 'desc' })
    await manager.updateVersion('id', 1, { envIds: ['prod'] })
    assert.deepEqual(calls.slice(1), [
      { template: 'v2', labels: ['prod'] },
      { description: 'desc' },
      { env_ids: ['prod'] },
    ])
    assert.deepEqual(await manager.delete('id'), { id: 'deleted' })
  })

  it('validates required and non-empty write options', () => {
    const manager = new PromptManager({ client: {} })
    assert.throws(() => manager.create(), TypeError)
    // @ts-expect-error Intentionally missing template.
    assert.throws(() => manager.create({ id: 'id' }), TypeError)
    assert.throws(() => manager.createVersion('id'), TypeError)
    assert.throws(() => manager.update('id'), /At least one/)
    assert.throws(() => manager.updateVersion('id', 1), /At least one/)
  })

  it('does not persist resolve results to warm cache', async () => {
    const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'dd-prompts-'))
    const manager = new PromptManager({
      env: 'prod',
      fileCacheEnabled: true,
      fileCacheDir: dir,
      client: {
        appKey: 'app',
        resolvePrompt: async () => ({ prompt_id: 'id', version: 1, template: 'x' }),
      },
    })
    await manager.get('id')
    assert.strictEqual(require('node:fs').readdirSync(dir).length, 0)
  })

  it('uses warm cache after a registry network failure', async () => {
    const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'dd-prompts-'))
    let fail = false
    const manager = new PromptManager({
      fileCacheEnabled: true,
      fileCacheDir: dir,
      client: {
        appKey: 'app',
        getPrompt: async () => {
          if (fail) throw new Error('offline')
          return { prompt_id: 'id', version: 1, template: 'cached' }
        },
      },
    })
    await manager.get('id')
    fail = true
    assert.strictEqual((await manager.refresh('id').catch(() => manager.get('id'))).render(), 'cached')
  })

  it('uses a real HTTP client for manager retrieval', async () => {
    const server = http.createServer((request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ prompt_id: 'id', version: 1, template: 'hello' }))
    })
    await new Promise(resolve => {
      server.once('listening', resolve)
      server.listen({ port: 0, host: '127.0.0.1' })
    })
    const client = new PromptsClient({
      apiKey: 'api',
      overrideOrigin: `http://127.0.0.1:${getPort(server)}`,
    })
    const manager = new PromptManager({ client })
    assert.strictEqual((await manager.get('id')).render(), 'hello')
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })

  it('uses a fallback for 404 and 500 responses while warning once', async () => {
    const warn = sinon.stub(log, 'warn')
    try {
      for (const status of [404, 500]) {
        const manager = new PromptManager({
          client: {
            getPrompt: async () => {
              const error = new Error(`status ${status}`)
              throw Object.assign(error, { status })
            },
          },
        })
        const prompt = await manager.get(`id-${status}`, { fallback: 'fallback' })
        assert.strictEqual(prompt.source, 'fallback')
      }
      assert.strictEqual(warn.calledTwice, true)
    } finally {
      warn.restore()
    }
  })

  it('propagates errors with detail when no fallback is provided', async () => {
    const error = Object.assign(new Error('missing'), { status: 404, detail: 'not found detail' })
    const manager = new PromptManager({ client: { getPrompt: async () => { throw error } } })
    await assert.rejects(manager.get('id'), thrown =>
      thrown instanceof Error && thrown === error && 'detail' in thrown && thrown.detail === 'not found detail')
  })

  it('does not call a callable fallback after successful retrieval', async () => {
    let called = false
    const manager = new PromptManager({
      client: { getPrompt: async () => ({ prompt_id: 'id', version: 1, template: 'x' }) },
    })
    await manager.get('id', { fallback: () => { called = true; return 'fallback' } })
    assert.strictEqual(called, false)
  })

  it('evicts all selectors when refresh receives a not-found response', async () => {
    let calls = 0
    const manager = new PromptManager({
      client: {
        getPrompt: async () => {
          calls++
          if (calls > 1) {
            const error = new Error('gone')
            throw Object.assign(error, { status: 404 })
          }
          return { prompt_id: 'id', version: 1, template: 'x' }
        },
      },
    })
    await manager.get('id')
    await assert.rejects(manager.refresh('id'),
      error => error instanceof Error && 'status' in error && error.status === 404)
    await assert.rejects(manager.get('id'),
      error => error instanceof Error && 'status' in error && error.status === 404)
  })

  it('clears hot and warm caches', async () => {
    let calls = 0
    const manager = new PromptManager({
      client: {
        getPrompt: async () => {
          calls++
          return { prompt_id: 'id', version: calls, template: String(calls) }
        },
      },
    })
    await manager.get('id')
    manager.clearCache()
    assert.strictEqual((await manager.get('id')).version, '2')
  })

  it('disables caching for an individual request with cacheTtl zero', async () => {
    let calls = 0
    const manager = new PromptManager({
      client: {
        getPrompt: async () => {
          calls++
          return { prompt_id: 'id', version: calls, template: String(calls) }
        },
      },
    })
    await manager.get('id', { cacheTtl: 0 })
    await manager.get('id', { cacheTtl: 0 })
    assert.strictEqual(calls, 2)
  })

  it('keeps cache entries separate for labels and environments', async () => {
    let calls = 0
    const manager = new PromptManager({
      env: 'prod',
      client: {
        appKey: 'app',
        resolvePrompt: async () => {
          calls++
          return { prompt_id: 'id', version: calls, template: String(calls) }
        },
        getPrompt: async options => {
          calls++
          return { prompt_id: 'id', version: options.label, template: String(calls) }
        },
      },
    })
    await manager.get('id', { label: 'one' })
    await manager.get('id', { label: 'two' })
    await manager.get('id')
    assert.strictEqual(calls, 3)
  })
})
