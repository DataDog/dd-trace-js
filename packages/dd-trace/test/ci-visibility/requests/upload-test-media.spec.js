'use strict'

const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const { describe, it, before, beforeEach } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../setup/core')

describe('ci-visibility/requests/upload-test-media', () => {
  const testRunId = '1234567890123456789'
  let tmpDir
  let requestStub
  let uploadTestMedia

  // Runs an upload for a file with the given basename and returns the request stub's call args
  // ({ path, headers, query }). The file is written with real non-empty bytes so readFileSync
  // succeeds. `extra` merges into the upload options (e.g. isEvpProxy / evpProxyPrefix).
  function uploadForFile (basename, extra = {}) {
    const filePath = join(tmpDir, basename)
    writeFileSync(filePath, 'not-empty')

    requestStub.resetHistory()
    uploadTestMedia(
      {
        filePath,
        testRunId,
        idempotencyKey: `${testRunId}:${basename}`,
        capturedAtMs: 1_700_000_000_000,
        url: new URL('http://localhost:8126'),
        ...extra,
      },
      () => {}
    )

    assert.ok(requestStub.calledOnce)
    const { path, headers } = requestStub.getCall(0).args[1]
    const query = new URL(path, 'http://localhost:8126').searchParams
    return { path, headers, query }
  }

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'upload-test-media-'))
  })

  beforeEach(() => {
    requestStub = sinon.stub().callsFake((_payload, _options, cb) => cb(null, 'ok', 200))
    const { uploadTestMedia: upload } = proxyquire(
      '../../../src/ci-visibility/requests/upload-test-media',
      {
        '../../config': () => ({ DD_API_KEY: 'test-api-key' }),
        '../../exporters/common/request': requestStub,
      }
    )
    uploadTestMedia = upload
  })

  describe('agentless', () => {
    it('sends the idempotency key (filename hex-encoded) and captured-at as query params (not headers)', () => {
      const basename = 'screenshot.png'
      const { headers, query } = uploadForFile(basename)

      const expectedKey = `${testRunId}:${Buffer.from(basename, 'utf8').toString('hex')}`
      assert.strictEqual(query.get('idempotency_key'), expectedKey)
      assert.strictEqual(query.get('captured_at_ms'), '1700000000000')
      // Metadata must not travel as X-Dd-* headers anymore (the proxy strips them).
      assert.strictEqual(headers['X-Dd-Idempotency-Key'], undefined)
      assert.strictEqual(headers['X-Dd-Media-Captured-At'], undefined)
    })

    it('posts to the media endpoint with the API key and no evp subdomain header', () => {
      const { path, headers } = uploadForFile('screenshot.png')

      assert.match(path, new RegExp(`^/api/v2/ci/test-runs/${testRunId}/media\\?`))
      assert.strictEqual(headers['DD-API-KEY'], 'test-api-key')
      assert.strictEqual(headers['X-Datadog-EVP-Subdomain'], undefined)
    })

    it('uses the Cypress video content type for MP4 files', () => {
      const { headers } = uploadForFile('test-run.mp4')

      assert.strictEqual(headers['Content-Type'], 'video/mp4')
    })

    it('reports an error when the request helper drops the upload', () => {
      const basename = 'screenshot.png'
      const filePath = join(tmpDir, basename)
      writeFileSync(filePath, 'not-empty')
      requestStub.callsFake((_payload, _options, cb) => cb(null))

      let callbackError
      uploadTestMedia(
        {
          filePath,
          testRunId,
          idempotencyKey: `${testRunId}:${basename}`,
          capturedAtMs: 1_700_000_000_000,
          url: new URL('http://localhost:8126'),
        },
        (err) => {
          callbackError = err
        }
      )

      assert.ok(requestStub.calledOnce)
      assert.ok(callbackError)
      assert.match(callbackError.message, /dropped/)
    })

    it('hex-encodes the filename in the idempotency key to the proxy-safe charset', () => {
      // A real failure screenshot name has spaces and parens (and here an em-dash, U+2014). The
      // Agent's evp_proxy validates the forwarded query against a restrictive charset and rejects
      // those, so the filename part is hex-encoded (test run ID and ':' stay readable); this also
      // keeps the path pure ASCII so http.request can't throw ERR_INVALID_CHAR.
      const basename = 'login — redirects to dashboard (failed).png'
      const { path, query } = uploadForFile(basename)

      const key = query.get('idempotency_key')
      // Only proxy-safe chars: test run ID digits, ':', hex filename — no spaces/parens/non-ASCII.
      assert.match(key, /^\d+:[0-9a-f]+$/)
      assert.strictEqual(key, `${testRunId}:${Buffer.from(basename, 'utf8').toString('hex')}`)
      // eslint-disable-next-line no-control-regex
      assert.match(path, /^[\x00-\x7F]+$/)
    })

    it('is deterministic for a non-ASCII filename', () => {
      const basename = 'shows 🎉 confetti (failed).png'
      const first = uploadForFile(basename).path
      const second = uploadForFile(basename).path

      assert.strictEqual(first, second)
    })
  })

  describe('agent (evp_proxy)', () => {
    const evpProxyPrefix = '/evp_proxy/v4'

    it('prefixes the evp_proxy path, sets the EVP subdomain header, and drops the API key', () => {
      const basename = 'screenshot.png'
      const { path, headers, query } = uploadForFile(basename, { isEvpProxy: true, evpProxyPrefix })

      assert.match(path, new RegExp(`^${evpProxyPrefix}/api/v2/ci/test-runs/${testRunId}/media\\?`))
      assert.strictEqual(headers['X-Datadog-EVP-Subdomain'], 'api')
      // The Agent injects the API key; the client must not send it.
      assert.strictEqual(headers['DD-API-KEY'], undefined)
      // Metadata still rides the query string (filename hex-encoded) so it survives the proxy.
      const expectedKey = `${testRunId}:${Buffer.from(basename, 'utf8').toString('hex')}`
      assert.strictEqual(query.get('idempotency_key'), expectedKey)
      assert.strictEqual(query.get('captured_at_ms'), '1700000000000')
    })
  })
})
