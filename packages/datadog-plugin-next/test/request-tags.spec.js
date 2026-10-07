'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const addOtelRequestTags = require('../src/request-tags')

/** @param {Record<string, unknown>} tags */
function createSpan (tags) {
  return { setTag: (key, value) => { tags[key] = value } }
}

describe('Next request metadata', () => {
  const config = {
    DD_TRACE_OTEL_SEMANTICS_ENABLED: true,
    queryStringObfuscation: /token=[^&]+/gi,
  }

  it('extracts the original Node URL, TLS scheme, user-agent and socket peer', () => {
    const tags = {}
    addOtelRequestTags(createSpan(tags), config, {
      headers: { host: 'example.com:8443', 'user-agent': 'node-agent/1.0' },
      url: '/rewritten',
      originalUrl: '/original?token=secret&keep=yes',
      socket: { encrypted: true, remoteAddress: '192.0.2.1' },
    })
    assert.deepStrictEqual(tags, {
      'http.url': 'https://example.com:8443/original?<redacted>&keep=yes',
      'http.useragent': 'node-agent/1.0',
      'network.peer.address': '192.0.2.1',
    })
  })

  it('updates URL and user-agent from a Web Request without erasing the Node socket peer', () => {
    const tags = {}
    const span = createSpan(tags)
    addOtelRequestTags(span, config, {
      headers: { host: 'node.example', 'user-agent': 'node-agent/1.0' },
      url: '/node',
      socket: { remoteAddress: '192.0.2.1' },
    })
    addOtelRequestTags(span, config, new Request('https://web.example/web?token=secret&keep=yes', {
      headers: { 'user-agent': 'web-agent/1.0' },
    }))
    assert.deepStrictEqual(tags, {
      'http.url': 'https://web.example/web?<redacted>&keep=yes',
      'http.useragent': 'web-agent/1.0',
      'network.peer.address': '192.0.2.1',
    })
  })

  for (const [kind, request] of [
    ['Node', { headers: { host: 'example.com' }, url: '/path?token=secret&keep=yes' }],
    ['Web', new Request('http://example.com/path?token=secret&keep=yes')],
  ]) {
    it(`does not add absent user-agent or peer metadata for a ${kind} request`, () => {
      const tags = {}
      addOtelRequestTags(createSpan(tags), config, request)
      assert.deepStrictEqual(tags, { 'http.url': 'http://example.com/path?<redacted>&keep=yes' })
    })

    for (const [queryStringObfuscation, suffix] of [
      [true, ''],
      [false, '?token=secret&keep=yes'],
    ]) {
      it(`honors queryStringObfuscation=${queryStringObfuscation} for a ${kind} request`, () => {
        const tags = {}
        addOtelRequestTags(createSpan(tags), { ...config, queryStringObfuscation }, request)
        assert.deepStrictEqual(tags, { 'http.url': `http://example.com/path${suffix}` })
      })
    }

    it(`adds no metadata when disabled for a ${kind} request`, () => {
      const tags = {}
      addOtelRequestTags(createSpan(tags), { ...config, DD_TRACE_OTEL_SEMANTICS_ENABLED: false }, request)
      assert.deepStrictEqual(tags, {})
    })
  }

  it('retains existing optional metadata when the Web Request has no user-agent', () => {
    const tags = { 'http.useragent': 'node-agent/1.0', 'network.peer.address': '192.0.2.1' }
    addOtelRequestTags(createSpan(tags), config, new Request('http://example.com/path'))
    assert.deepStrictEqual(tags, {
      'http.url': 'http://example.com/path',
      'http.useragent': 'node-agent/1.0',
      'network.peer.address': '192.0.2.1',
    })
  })

  it('ignores requests without headers', () => {
    const tags = {}
    addOtelRequestTags(createSpan(tags), config, {})
    assert.deepStrictEqual(tags, {})
  })
})
