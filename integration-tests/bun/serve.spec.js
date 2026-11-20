'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const { join } = require('node:path')

const { BUN } = require('../helpers/bun')
const { FakeAgent, useSandbox, sandboxCwd, spawnProc, spawnProcAndExpectExit, stopProc } = require('../helpers')

/**
 * @param {string} url
 * @param {import('node:http').RequestOptions} [options]
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, body: string }>}
 */
function request (url, options) {
  return new Promise((resolve, reject) => {
    http.get(url, options, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
      res.on('error', reject)
    }).on('error', reject)
  })
}

describe('Bun.serve', function () {
  this.timeout(30_000)
  useSandbox(['hono', 'elysia@1.4.32'])

  let agent, child, spans

  beforeEach(async () => {
    spans = []
    agent = await new FakeAgent().start()
    agent.on('message', ({ payload }) => spans.push(...payload.flat()))
  })

  afterEach(async () => {
    if (child) await stopProc(child)
    child = undefined
    await agent.stop()
  })

  /**
   * @param {string} [testCase]
   * @param {string} [filename]
   */
  async function start (testCase = '', filename = 'server.js') {
    child = await spawnProc(join(sandboxCwd(), 'bun/serve', filename), {
      execPath: BUN,
      env: {
        ...process.env,
        DD_TRACE_AGENT_URL: `http://127.0.0.1:${agent.port}`,
        DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
        TEST_CASE: testCase,
      },
    })
    return child.url
  }

  /** @param {(span: object) => void} check */
  function serverSpan (check) {
    return agent.assertMessageReceived(() => {
      const servers = spans.filter(span => span.meta['span.kind'] === 'server')
      assert.strictEqual(servers.length, 1)
      check(servers[0])
    }, 10_000)
  }

  for (const path of ['/', '/async']) {
    it(`traces ${path} with standard HTTP tags and request context`, async () => {
      const url = await start()
      const received = serverSpan(span => {
        assert.strictEqual(span.name, 'web.request')
        assert.strictEqual(span.type, 'web')
        assert.strictEqual(span.meta.component, 'http')
        assert.strictEqual(span.meta['http.method'], 'GET')
        assert.strictEqual(span.meta['http.url'], url + path)
        assert.strictEqual(span.meta['http.status_code'], '200')
        assert.strictEqual(span.meta['http.request.headers.x-request-test'], 'request-value')
        if (path === '/') {
          assert.strictEqual(span.meta['http.response.headers.x-response-test'], 'response-value')
        }
      })
      const [response] = await Promise.all([
        request(url + path, { headers: { 'x-request-test': 'request-value' } }), received,
      ])
      assert.strictEqual(response.status, 200)
      assert.strictEqual(response.body, path === '/async' ? 'async' : 'ok')
    })
  }

  it('continues a trace from an instrumented Node HTTP client', async () => {
    const url = await start()
    const received = agent.assertMessageReceived(() => {
      const client = spans.find(span => span.name === 'http.request')
      const server = spans.find(span => span.name === 'web.request')
      const parent = spans.find(span => span.name === 'node.parent')
      assert.ok(client && server && parent)
      assert.strictEqual(server.trace_id, client.trace_id)
      assert.strictEqual(server.parent_id, client.span_id)
      assert.strictEqual(client.parent_id, parent.span_id)
    }, 10_000)
    await Promise.all([
      spawnProcAndExpectExit(join(sandboxCwd(), 'bun/serve/client.js'), {
        env: {
          ...process.env,
          DD_TRACE_AGENT_URL: `http://127.0.0.1:${agent.port}`,
          DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
          SERVER_URL: url,
        },
      }),
      received,
    ])
  })

  it('isolates concurrent requests and their incoming trace contexts', async () => {
    const url = await start()
    const received = agent.assertMessageReceived(() => {
      const servers = spans.filter(span => span.name === 'web.request')
      assert.strictEqual(servers.length, 4)
      for (let i = 1; i <= 4; i++) {
        const span = servers.find(span => span.meta['http.url'] === `${url}/concurrent/${i}`)
        assert.ok(span)
        assert.strictEqual(span.trace_id.toString(), String(i))
        assert.strictEqual(span.parent_id.toString(), String(i + 10))
      }
    }, 10_000)
    await Promise.all([
      ...[1, 2, 3, 4].map(i => request(`${url}/concurrent/${i}`, {
        headers: { 'x-datadog-trace-id': String(i), 'x-datadog-parent-id': String(i + 10) },
      })),
      received,
    ])
  })

  it('finishes concurrent requests that reject with the same error object', async () => {
    const url = await start('custom-error')
    const received = agent.assertMessageReceived(() => {
      const servers = spans.filter(span => span.name === 'web.request')
      assert.strictEqual(servers.length, 2)
      for (const span of servers) {
        assert.strictEqual(span.meta['http.status_code'], '502')
        assert.strictEqual(span.meta['error.message'], 'shared failure')
      }
    }, 10_000)
    const [a, b] = await Promise.all([request(url + '/shared-error'), request(url + '/shared-error'), received])
    assert.strictEqual(a.status, 502)
    assert.strictEqual(b.status, 502)
  })

  it('keeps custom error handlers in their request context when an Error is shared', async () => {
    const url = await start('custom-error')
    const received = agent.assertMessageReceived(() => {
      const servers = spans.filter(span => span.name === 'web.request')
      const handlers = spans.filter(span => span.name === 'custom.error')
      assert.strictEqual(servers.length, 2)
      assert.strictEqual(handlers.length, 2)
      for (const id of ['1', '2']) {
        const server = servers.find(span => span.meta['http.url'] === `${url}/shared-error/${id}`)
        const handler = handlers.find(span => span.trace_id.toString() === id)
        assert.ok(server && handler)
        assert.strictEqual(server.trace_id.toString(), id)
        assert.strictEqual(handler.parent_id, server.span_id)
        assert.strictEqual(server.meta['http.status_code'], '502')
        assert.strictEqual(server.meta['error.message'], 'shared failure')
      }
    }, 10_000)
    const responses = await Promise.all([
      ...['1', '2'].map(id => request(`${url}/shared-error/${id}`, {
        headers: { 'x-datadog-trace-id': id, 'x-datadog-parent-id': '10' },
      })),
      received,
    ])
    assert.strictEqual(responses[0].body, '1')
    assert.strictEqual(responses[1].body, '2')
  })

  it('records successful WebSocket upgrades as 101 without an error', async () => {
    const url = await start()
    const received = serverSpan(span => {
      assert.strictEqual(span.meta['http.status_code'], '101')
      assert.strictEqual(span.error, 0)
      assert.strictEqual(span.meta['error.message'], undefined)
    })
    await Promise.all([
      spawnProcAndExpectExit(join(sandboxCwd(), 'bun/serve/websocket-client.js'), {
        execPath: BUN,
        env: { ...process.env, SERVER_URL: url },
      }),
      received,
    ])
  })

  it('finishes client aborts like Node HTTP without inventing a 500', async () => {
    const url = await start()
    const received = serverSpan(span => {
      assert.strictEqual(span.meta['http.status_code'], '200')
      assert.strictEqual(span.meta['test.aborted'], 'true')
      assert.strictEqual(span.error, 0)
      assert.strictEqual(span.meta['error.message'], undefined)
    })
    await Promise.all([
      new Promise((resolve, reject) => {
        const req = http.get(url + '/abort')
        const onMessage = ({ event }) => {
          if (event !== 'pending') return
          child.off('message', onMessage)
          req.destroy()
        }
        child.on('message', onMessage)
        req.once('error', error => {
          if (error.code === 'ECONNRESET') resolve()
          else reject(error)
        })
      }),
      received,
    ])
  })

  for (const [path, testCase, status, message] of [
    ['/unavailable', '', 503],
    ['/throw', '', 500, 'sync failure'],
    ['/reject', '', 500, 'async failure'],
    ['/throw', 'custom-error', 502, 'sync failure'],
    ['/reject', 'custom-error', 502, 'async failure'],
  ]) {
    it(`records ${status} for ${path} ${testCase}`, async () => {
      const url = await start(testCase)
      const received = serverSpan(span => {
        assert.strictEqual(span.meta['http.status_code'], String(status))
        assert.strictEqual(span.error, 1)
        if (message) assert.strictEqual(span.meta['error.message'], message)
      })
      const [response] = await Promise.all([request(url + path), received])
      assert.strictEqual(response.status, status)
    })
  }

  it('injects CORS propagation response headers using the HTTP server behavior', async () => {
    const url = await start()
    const received = serverSpan(span => assert.strictEqual(span.meta['http.method'], 'OPTIONS'))
    const [response] = await Promise.all([
      request(url, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://example.com',
          'access-control-request-headers': 'traceparent,x-datadog-trace-id,x-datadog-parent-id',
        },
      }), received,
    ])
    assert.strictEqual(response.headers['access-control-allow-headers'],
      'content-type,traceparent,x-datadog-parent-id,x-datadog-trace-id')
  })

  it('preserves immutable redirect responses', async () => {
    const url = await start()
    const received = serverSpan(span => assert.strictEqual(span.meta['http.status_code'], '302'))
    const [response] = await Promise.all([request(url + '/redirect'), received])
    assert.strictEqual(response.status, 302)
    assert.strictEqual(response.headers.location, 'https://example.com/')
  })

  it('preserves streaming response bodies', async () => {
    const url = await start()
    const received = serverSpan(span => assert.strictEqual(span.meta['http.status_code'], '200'))
    const [response] = await Promise.all([request(url + '/stream'), received])
    assert.strictEqual(response.body, 'streamed body')
  })

  it('honors disabling the HTTP plugin', async () => {
    const url = await start('disabled')
    const received = agent.assertMessageReceived(() => {
      assert.ok(spans.some(span => span.name === 'disabled.control'))
      assert.ok(spans.every(span => span.meta['span.kind'] !== 'server'))
    }, 10_000)
    const staticResult = await request(url + '/static')
    assert.strictEqual(staticResult.body, 'static')
    const [response] = await Promise.all([request(url), received])
    assert.strictEqual(response.body, 'disabled')
  })

  it('leaves static Response routes and method maps on the native fast path', async () => {
    const url = await start('routes')
    for (const path of ['/static', '/static-method']) {
      const response = await request(url + path)
      assert.strictEqual(response.status, 200)
      assert.strictEqual(response.body, 'static')
    }
    const received = serverSpan(span => assert.strictEqual(span.meta['http.url'], url + '/'))
    await Promise.all([request(url), received])
  })

  for (const [path, route, status, body] of [
    ['/', undefined, 200, 'reloaded'],
    ['/reloaded/42', '/reloaded/:id', 200, '42'],
    ['/reload-error', '/reload-error', 502, 'reload failure'],
  ]) {
    it(`traces replacement handlers installed with server.reload (${path})`, async () => {
      const url = await start('reload')
      const received = serverSpan(span => {
        assert.strictEqual(span.meta['http.status_code'], String(status))
        assert.strictEqual(span.meta['http.route'], route)
        if (status === 502) assert.strictEqual(span.meta['error.message'], 'reload failure')
      })
      const [response] = await Promise.all([request(url + path), received])
      assert.strictEqual(response.status, status)
      assert.strictEqual(response.body, body)
    })
  }

  it('does not wrap Bun-like globals on Node', () => {
    return spawnProcAndExpectExit(join(sandboxCwd(), 'bun/serve/node-gating.js'), {
      env: { ...process.env, DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false' },
    })
  })

  for (const filename of ['server.js', 'default-app.mjs']) {
    it(`traces Hono with its route (${filename})`, async () => {
      const url = await start('hono', filename)
      const received = serverSpan(span => {
        assert.strictEqual(span.name, 'hono.request')
        assert.strictEqual(span.resource, 'GET /users/:id')
        assert.strictEqual(span.meta.component, 'hono')
        assert.strictEqual(span.meta['http.route'], '/users/:id')
        assert.strictEqual(span.meta['http.status_code'], '200')
      })
      const [response] = await Promise.all([request(url + '/users/42'), received])
      assert.strictEqual(response.body, '42')
    })
  }

  it('traces Elysia native routes after its automatic server.reload', async () => {
    const url = await start('', 'elysia.mjs')
    const first = await request(url + '/users/41')
    assert.strictEqual(first.body, '41')
    const received = agent.assertMessageReceived(() => {
      const servers = spans.filter(span => span.meta['span.kind'] === 'server')
      assert.strictEqual(servers.length, 2)
      for (const span of servers) {
        assert.strictEqual(span.name, 'web.request')
        assert.strictEqual(span.resource, 'GET /users/:id')
        assert.strictEqual(span.meta['http.route'], '/users/:id')
        assert.strictEqual(span.meta['http.status_code'], '200')
      }
    }, 10_000)
    const [second] = await Promise.all([request(url + '/users/42'), received])
    assert.strictEqual(second.body, '42')
  })

  for (const [path, route, method, body, status] of [
    ['/native/42', '/native/:id', 'GET', '42', 200],
    ['/method', '/method', 'POST', 'POST', 200],
    ['/route-error', '/route-error', 'GET', undefined, 500],
  ]) {
    it(`traces native routes (${method} ${path})`, async () => {
      const url = await start(path === '/native/42' ? 'routes-only' : 'routes')
      const received = serverSpan(span => {
        assert.strictEqual(span.name, 'web.request')
        assert.strictEqual(span.meta['http.route'], route)
        assert.strictEqual(span.resource, `${method} ${route}`)
        assert.strictEqual(span.meta['http.status_code'], String(status))
        if (status === 500) assert.strictEqual(span.meta['error.message'], 'route failure')
      })
      const [response] = await Promise.all([request(url + path, { method }), received])
      assert.strictEqual(response.status, status)
      if (body) assert.strictEqual(response.body, body)
    })
  }
})
