'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

require('../../dd-trace/test/setup/core')

const GrpcClientPlugin = require('../src/client')

// Exercise the peer-string parser inside `GrpcClientPlugin.prototype.finish`
// directly via `.call(fakeThis, ...)`. The tightened parser only emits
// `network.destination.port` when the last segment is strictly numeric
// *and* a colon is present; the previous `/^\d+/` and `split(':')` shape
// let two malformed-peer cases through.
function tagsFor (peer) {
  const tags = {}
  const fakeSpan = {
    setTag (key, value) { tags[key] = value },
    finish () {},
  }
  const fakePlugin = {
    config: {},
    addCode () {},
    tagPeerService () {},
  }
  GrpcClientPlugin.prototype.finish.call(fakePlugin, { span: fakeSpan, result: {}, peer })
  return tags
}

describe('grpc client finish peer-string tags', () => {
  it('splits a standard `ipv4:port` peer', () => {
    assert.deepStrictEqual(tagsFor('127.0.0.1:50051'), {
      'network.destination.ip': '127.0.0.1',
      'network.destination.port': '50051',
    })
  })

  it('splits an IPv6-style peer on the last colon only', () => {
    assert.deepStrictEqual(tagsFor('[::1]:50051'), {
      'network.destination.ip': '[::1]',
      'network.destination.port': '50051',
    })
    assert.deepStrictEqual(tagsFor('::1:50051'), {
      'network.destination.ip': '::1',
      'network.destination.port': '50051',
    })
  })

  it('drops the port tag when the trailing segment is only partially numeric', () => {
    // Regression: `/^\d+/` was unanchored, so the previous parser tagged
    // `port='80abc'` and `ip='1.2.3.4'`. The anchored `/^\d+$/` rejects
    // the entire tail and falls back to tagging the raw peer.
    assert.deepStrictEqual(tagsFor('1.2.3.4:80abc'), {
      'network.destination.ip': '1.2.3.4:80abc',
    })
  })

  it('drops the port tag for pure-digit peers without a colon', () => {
    // Regression: `'8080'.split(':') === ['8080']`, the unanchored regex
    // matched, and `parts.slice(0, -1).join(':')` produced an empty `ip`,
    // so a peer with no host info leaked `ip=''` plus a numeric `port`.
    assert.deepStrictEqual(tagsFor('8080'), { 'network.destination.ip': '8080' })
    assert.deepStrictEqual(tagsFor('12abc'), { 'network.destination.ip': '12abc' })
  })

  it('tags the raw peer for unix-socket peers', () => {
    assert.deepStrictEqual(tagsFor('unix:'), { 'network.destination.ip': 'unix:' })
    assert.deepStrictEqual(tagsFor('unix:/tmp/socket'), { 'network.destination.ip': 'unix:/tmp/socket' })
  })

  it('tags the raw peer when there is no colon and no digits', () => {
    assert.deepStrictEqual(tagsFor('localhost'), { 'network.destination.ip': 'localhost' })
  })

  it('still tags an empty ip when the host half is empty (existing behaviour)', () => {
    // Boundary: the parser does not require a non-empty *host* — a malformed
    // peer with an empty host but a strictly numeric port still yields the
    // (empty, numeric) split. This matches both the previous and the new
    // parser; pinning it so a future tightening does not drop it silently.
    assert.deepStrictEqual(tagsFor(':50051'), {
      'network.destination.ip': '',
      'network.destination.port': '50051',
    })
  })
})
