'use strict'

/* eslint-disable no-console */

const fs = require('fs')
const http = require('http')
const net = require('net')
const path = require('path')
const zlib = require('zlib')

const { decodeBody } = require('./payload-decoder')
const { sanitizeForReport } = require('./redaction')

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024
const DEFAULT_SETTINGS = {
  code_coverage: false,
  tests_skipping: false,
  itr_enabled: false,
  require_git: false,
  early_flake_detection: {
    enabled: false,
    slow_test_retries: {
      '5s': 3,
    },
  },
  flaky_test_retries_enabled: false,
  di_enabled: false,
  known_tests_enabled: false,
  test_management: {
    enabled: false,
  },
  impacted_tests_enabled: false,
  coverage_report_upload_enabled: false,
}

class MockIntake {
  constructor ({ out, verbose = false, maxBodyBytes = DEFAULT_MAX_BODY_BYTES }) {
    this.out = out
    this.verbose = verbose
    this.maxBodyBytes = maxBodyBytes
    this.port = null
    this.server = null
    this.requests = []
    this.allRequests = []
    this.reset()
  }

  reset () {
    this.requests = []
    this.allRequests = []
    this.settings = { ...DEFAULT_SETTINGS }
    this.knownTests = {}
    this.testManagementTests = {}
  }

  resetRequests () {
    this.requests = []
  }

  configure ({ settings, knownTests, testManagementTests } = {}) {
    this.settings = { ...DEFAULT_SETTINGS }
    if (settings) {
      Object.assign(this.settings, settings)
    }
    this.knownTests = knownTests || {}
    this.testManagementTests = testManagementTests || {}
  }

  async start () {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch(err => {
        this.record(req, null, { decodeError: err.message })
        res.statusCode = 500
        res.end(JSON.stringify({ errors: [err.message] }))
      })
    })

    try {
      await listenOnLocalhost(this.server)
      this.port = this.server.address().port
      await verifyLocalConnection(this.port)
    } catch (err) {
      await closeServer(this.server)
      this.server = null
      this.port = null
      throw err
    }
  }

  async close () {
    if (!this.server) return
    await closeServer(this.server)
    this.server = null
    this.port = null
  }

  async handle (req, res) {
    const body = await readBody(req, this.maxBodyBytes)
    const decoded = decodeSafely(body, req.headers)
    const url = req.url

    if (req.method === 'GET' && url === '/info') {
      this.record(req, decoded)
      sendJson(res, 200, { endpoints: ['/evp_proxy/v2', '/debugger/v1/input'] })
      return
    }

    if (req.method === 'PUT' && url.startsWith('/v0.4/traces')) {
      this.record(req, decoded)
      sendJson(res, 200, { rate_by_service: { 'service:,env:': 1 } })
      return
    }

    if (req.method === 'POST' && url.endsWith('/api/v2/citestcycle')) {
      this.record(req, decoded)
      res.statusCode = 200
      res.end('OK')
      return
    }

    if (req.method === 'POST' && url.endsWith('/api/v2/libraries/tests/services/setting')) {
      this.record(req, decoded)
      sendJson(res, 200, { data: { attributes: this.settings } })
      return
    }

    if (req.method === 'POST' && url.endsWith('/api/v2/ci/libraries/tests')) {
      this.record(req, decoded)
      sendMaybeGzipJson(req, res, 200, { data: { attributes: { tests: this.knownTests } } })
      return
    }

    if (req.method === 'POST' && url.endsWith('/api/v2/test/libraries/test-management/tests')) {
      this.record(req, decoded)
      sendJson(res, 200, { data: { attributes: { modules: this.testManagementTests } } })
      return
    }

    if (req.method === 'POST' && url.endsWith('/api/v2/ci/tests/skippable')) {
      this.record(req, decoded)
      sendJson(res, 200, { data: [], meta: { correlation_id: 'dd-test-optimization-validation' } })
      return
    }

    if (req.method === 'POST' && (
      url.endsWith('/api/v2/git/repository/search_commits') ||
      url.endsWith('/api/v2/git/repository/packfile') ||
      url.endsWith('/telemetry/proxy/api/v2/apmtelemetry') ||
      url.endsWith('/api/v2/logs') ||
      url.endsWith('/debugger/v1/input')
    )) {
      this.record(req, decoded)
      sendJson(res, 200, { data: [] })
      return
    }

    this.record(req, decoded, { unmatched: true })
    sendJson(res, 404, { errors: [`Unhandled validation intake endpoint: ${req.method} ${url}`] })
  }

  record (req, payload, extra = {}) {
    const request = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      payload,
      receivedAt: new Date().toISOString(),
      ...extra,
    }
    this.requests.push(request)
    this.allRequests.push(request)
    if (this.verbose) {
      console.log(`[test-optimization-validator] intake ${req.method} ${req.url}`)
    }
  }

  getArtifactRequests () {
    return this.allRequests.length > 0 ? this.allRequests : this.requests
  }

  writeArtifacts () {
    const intakeDir = path.join(this.out, 'intake')
    fs.mkdirSync(intakeDir, { recursive: true })
    const requestsPath = path.join(intakeDir, 'requests.ndjson')
    const requests = this.getArtifactRequests()
    fs.writeFileSync(
      requestsPath,
      requests.map(request => JSON.stringify(sanitizeForReport(request))).join('\n') + '\n'
    )
    return { requestsPath }
  }
}

function listenOnLocalhost (server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function verifyLocalConnection (port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const cleanup = () => {
      socket.off('connect', onConnect)
      socket.off('error', onError)
    }
    const onConnect = () => {
      cleanup()
      socket.end()
      resolve()
    }
    const onError = err => {
      cleanup()
      reject(err)
    }

    socket.once('connect', onConnect)
    socket.once('error', onError)
  })
}

function closeServer (server) {
  if (!server || !server.listening) return Promise.resolve()
  return new Promise(resolve => server.close(resolve))
}

function decodeSafely (body, headers) {
  if (body.truncated) {
    return {
      decodeError: `Request body exceeded ${body.maxBodyBytes} bytes and was truncated.`,
      bodyBytesRead: body.bytesRead,
      bodyBytesCaptured: body.bytesCaptured,
      bodyTruncated: true,
      maxBodyBytes: body.maxBodyBytes,
    }
  }

  if (body.content.length === 0) return null

  try {
    return decodeBody(body.content, headers)
  } catch (err) {
    return {
      decodeError: err.message,
      bodyBytesRead: body.bytesRead,
      bodyBytesCaptured: body.bytesCaptured,
      bodyTruncated: false,
    }
  }
}

function readBody (req, maxBodyBytes = DEFAULT_MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytesRead = 0
    let bytesCaptured = 0

    req.on('data', chunk => {
      bytesRead += chunk.length
      const remaining = maxBodyBytes - bytesCaptured
      if (remaining <= 0) return

      if (chunk.length <= remaining) {
        chunks.push(chunk)
        bytesCaptured += chunk.length
      } else {
        chunks.push(chunk.subarray(0, remaining))
        bytesCaptured += remaining
      }
    })
    req.on('error', reject)
    req.on('end', () => resolve({
      content: Buffer.concat(chunks),
      bytesRead,
      bytesCaptured,
      truncated: bytesRead > maxBodyBytes,
      maxBodyBytes,
    }))
  })
}

function sendJson (res, statusCode, body) {
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

function sendMaybeGzipJson (req, res, statusCode, body) {
  const response = Buffer.from(JSON.stringify(body))
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json')
  if (String(req.headers['accept-encoding'] || '').includes('gzip')) {
    res.setHeader('content-encoding', 'gzip')
    res.end(zlib.gzipSync(response))
    return
  }
  res.end(response)
}

module.exports = { MockIntake, DEFAULT_SETTINGS }
