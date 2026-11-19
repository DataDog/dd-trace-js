'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const { once } = require('node:events')

const { describe, it, beforeEach, afterEach } = require('mocha')

require('../../setup/core')

const { OtlpProfilesExporter } = require('../../../src/profiling/exporters/otlp')

describe('exporters/otlp', () => {
  let server
  let requests
  let status

  beforeEach(async () => {
    requests = []
    status = 200
    server = http.createServer((req, res) => {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) })
        res.statusCode = status
        res.end()
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
  })

  afterEach(() => {
    server.close()
  })

  function createExporter () {
    return new OtlpProfilesExporter({
      OTEL_EXPORTER_OTLP_PROFILES_ENDPOINT: `http://127.0.0.1:${server.address().port}/v1development/profiles`,
      OTEL_EXPORTER_OTLP_PROFILES_HEADERS: { 'dd-api-key': 'secret' },
      OTEL_EXPORTER_OTLP_PROFILES_TIMEOUT: 5000,
    })
  }

  it('should send the encoded OTLP request to the profiles endpoint', async () => {
    const otlp = Buffer.from([0x0a, 0x02, 0x08, 0x01])

    await createExporter().export({ profiles: {}, otlp })

    assert.strictEqual(requests.length, 1)
    const [request] = requests
    assert.strictEqual(request.method, 'POST')
    assert.strictEqual(request.url, '/v1development/profiles')
    assert.strictEqual(request.headers['content-type'], 'application/x-protobuf')
    assert.strictEqual(request.headers['otlp-profiles-development-version'], '1')
    assert.strictEqual(request.headers['dd-api-key'], 'secret')
    assert.deepStrictEqual(request.body, otlp)
  })

  it('should reject when the endpoint fails the request', async () => {
    status = 503

    await assert.rejects(createExporter().export({ profiles: {}, otlp: Buffer.from([0]) }))
    assert.strictEqual(requests.length, 1)
  })

  it('should not send exports without an OTLP request, such as near-OOM heap snapshots', async () => {
    await createExporter().export({ profiles: { space: Buffer.from('pprof') } })

    assert.strictEqual(requests.length, 0)
  })

  it('should not take part in the near-OOM export subprocess', () => {
    assert.strictEqual(createExporter().getExportUrl(), undefined)
  })
})
