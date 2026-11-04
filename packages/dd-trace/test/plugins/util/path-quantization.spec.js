'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')

require('../../setup/core')

describe('plugins/util/path-quantization', () => {
  let quantizePath
  let clientResourceName

  beforeEach(() => {
    ;({ quantizePath, clientResourceName } = require('../../../src/plugins/util/path-quantization'))
  })

  describe('preserved segments', () => {
    it('keeps segments made only of letters', () => {
      assert.strictEqual(quantizePath('/users'), '/users')
      assert.strictEqual(quantizePath('/api/users/profile'), '/api/users/profile')
    })

    it('keeps hyphens and underscores', () => {
      assert.strictEqual(quantizePath('/service-order/lot_details'), '/service-order/lot_details')
    })

    it('keeps API version segments', () => {
      assert.strictEqual(quantizePath('/v1/users'), '/v1/users')
      assert.strictEqual(quantizePath('/v42/users'), '/v42/users')
    })

    it('does not treat an arbitrary letter-digit segment as a version', () => {
      assert.strictEqual(quantizePath('/x1/users'), '/?/users')
      assert.strictEqual(quantizePath('/v1beta/users'), '/?/users')
    })
  })

  describe('replaced segments', () => {
    it('replaces segments containing digits', () => {
      assert.strictEqual(quantizePath('/users/12345'), '/users/?')
      assert.strictEqual(quantizePath('/notes/L/31300769'), '/notes/L/?')
    })

    it('replaces segments containing special characters', () => {
      assert.strictEqual(quantizePath('/users/john.smith@example.com'), '/users/?')
      assert.strictEqual(quantizePath('/search/hello%20world'), '/search/?')
    })

    it('replaces segments containing non-ASCII characters', () => {
      assert.strictEqual(quantizePath('/articles/café'), '/articles/?')
    })

    it('replaces every offending segment independently', () => {
      assert.strictEqual(quantizePath('/v1/lots/8675309/photos/abc123'), '/v1/lots/?/photos/?')
    })
  })

  describe('structure', () => {
    it('returns / for an empty or root path', () => {
      assert.strictEqual(quantizePath(''), '/')
      assert.strictEqual(quantizePath('/'), '/')
      assert.strictEqual(quantizePath(undefined), '/')
    })

    it('roots a relative path', () => {
      assert.strictEqual(quantizePath('users/123'), '/users/?')
    })

    it('preserves a trailing slash', () => {
      assert.strictEqual(quantizePath('/users/123/'), '/users/?/')
    })

    it('preserves empty interior segments', () => {
      assert.strictEqual(quantizePath('/users//123'), '/users//?')
    })
  })

  describe('idempotency', () => {
    it('is a no-op when re-quantizing an already quantized path', () => {
      const once = quantizePath('/v1/lots/8675309/photos/abc123')

      assert.strictEqual(quantizePath(once), once)
    })

    it('does not truncate at the placeholder', () => {
      assert.strictEqual(quantizePath('/users/?/view'), '/users/?/view')
    })
  })

  describe('percent-decoding', () => {
    it('keeps a segment that is unremarkable once decoded', () => {
      assert.strictEqual(quantizePath('/%68ello/123'), '/hello/?')
      assert.strictEqual(quantizePath('/v1/%41BC'), '/v1/ABC')
    })

    // Decoding the whole path first would turn this into `/files/a/b`, inventing
    // a segment boundary the request never had and leaving the value unquantized.
    it('does not let an encoded slash create a segment boundary', () => {
      assert.strictEqual(quantizePath('/files/a%2Fb'), '/files/?')
    })

    it('replaces a segment that is still special once decoded', () => {
      assert.strictEqual(quantizePath('/search/hello%20world'), '/search/?')
      assert.strictEqual(quantizePath('/articles/caf%C3%A9'), '/articles/?')
    })

    it('emits invalid escapes verbatim instead of throwing', () => {
      assert.strictEqual(quantizePath('/a%ZZb/users'), '/?/users')
      assert.strictEqual(quantizePath('/users/%'), '/users/?')
      assert.strictEqual(quantizePath('/users/%4'), '/users/?')
    })
  })

  describe('clientResourceName', () => {
    it('returns the bare method when disabled', () => {
      assert.strictEqual(clientResourceName('GET', '/users/123', false), 'GET')
      assert.strictEqual(clientResourceName('GET', '/users/123', undefined), 'GET')
    })

    it('appends the quantized path when enabled', () => {
      assert.strictEqual(clientResourceName('POST', '/users/123', true), 'POST /users/?')
      assert.strictEqual(clientResourceName('GET', '/health/status', true), 'GET /health/status')
    })
  })
})
