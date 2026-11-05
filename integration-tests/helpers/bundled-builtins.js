'use strict'

const assert = require('node:assert/strict')

/**
 * Waits for the spans produced by the bundled built-ins fixture: an HTTP server span for the incoming request,
 * the client span of its `node:http` request, and the span of its `node:dns` lookup.
 *
 * @param {import('./fake-agent')} agent
 */
function assertBuiltinSpans (agent) {
  const spans = []
  return agent.assertMessageReceived(({ payload }) => {
    spans.push(...payload.flat())

    const server = spans.find(span => span.name === 'web.request' &&
      new URL(span.meta['http.url']).pathname === '/')
    assert.ok(server, 'node:http server span')

    const client = spans.find(span => span.name === 'http.request' &&
      new URL(span.meta['http.url']).pathname === '/target')
    assert.ok(client, 'node:http client span')
    assert.equal(client.meta['http.status_code'], '200')
    assert.equal(client.error, 0)

    const dns = spans.find(span => span.name === 'dns.lookup' && span.resource === 'localhost')
    assert.ok(dns, 'node:dns lookup span')
    assert.equal(dns.meta['dns.address'], '127.0.0.1')
    assert.equal(dns.error, 0)
  }, 10_000, 1, true)
}

module.exports = { assertBuiltinSpans }
