'use strict'

const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const { describe, it, before, beforeEach } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../setup/core')

describe('ci-visibility/requests/upload-test-screenshot', () => {
  const traceId = '1234567890123456789'
  let tmpDir
  let requestStub
  let uploadTestScreenshot

  // Returns the X-Dd-Idempotency-Key header value the upload would put on the wire for a given
  // file basename. The file is written with real non-empty bytes so readFileSync succeeds.
  function uploadHeaderValueForFile (basename) {
    const filePath = join(tmpDir, basename)
    writeFileSync(filePath, 'not-empty')

    requestStub.resetHistory()
    uploadTestScreenshot(
      {
        filePath,
        traceId,
        idempotencyKey: `${traceId}:${basename}`,
        capturedAtMs: 1_700_000_000_000,
        url: new URL('http://localhost:8126'),
      },
      () => {}
    )

    assert.ok(requestStub.calledOnce)
    const headers = requestStub.getCall(0).args[1].headers
    assert.strictEqual(headers['DD-API-KEY'], 'test-api-key')
    return headers['X-Dd-Idempotency-Key']
  }

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'upload-test-screenshot-'))
  })

  beforeEach(() => {
    requestStub = sinon.stub().callsFake((_payload, _options, cb) => cb(null, 'ok', 200))
    const { uploadTestScreenshot: upload } = proxyquire(
      '../../../src/ci-visibility/requests/upload-test-screenshot',
      {
        '../../config': () => ({ DD_API_KEY: 'test-api-key' }),
        '../../exporters/common/request': requestStub,
      }
    )
    uploadTestScreenshot = upload
  })

  it('keeps the trace id verbatim and hex-encodes an ASCII filename', () => {
    const basename = 'screenshot.png'
    const headerValue = uploadHeaderValueForFile(basename)

    const expectedFilenameHex = Buffer.from(basename, 'utf8').toString('hex')
    assert.strictEqual(headerValue, `${traceId}:${expectedFilenameHex}`)
  })

  it('hex-encodes a non-ASCII filename so http.request cannot throw ERR_INVALID_CHAR', () => {
    // A real failure screenshot name: the test title has an em-dash (U+2014), the kind of
    // above-Latin-1 character that makes http.request throw ERR_INVALID_CHAR if sent raw.
    const basename = 'login — redirects to dashboard (failed).png'
    const headerValue = uploadHeaderValueForFile(basename)

    // The whole header value must be ASCII so it never trips ERR_INVALID_CHAR.
    // eslint-disable-next-line no-control-regex
    assert.match(headerValue, /^[\x00-\x7F]+$/)
    assert.match(headerValue, new RegExp(`^${traceId}:[0-9a-f]+$`))

    const expectedFilenameHex = Buffer.from(basename, 'utf8').toString('hex')
    assert.strictEqual(headerValue, `${traceId}:${expectedFilenameHex}`)
  })

  it('is deterministic for a non-ASCII filename', () => {
    const basename = 'shows 🎉 confetti (failed).png'
    const first = uploadHeaderValueForFile(basename)
    const second = uploadHeaderValueForFile(basename)

    assert.strictEqual(first, second)
  })
})
