#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */

const fs = require('node:fs')
const { randomBytes } = require('node:crypto')
const http = require('node:http')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const zlib = require('node:zlib')

const {
  analyzeIntakeArtifact,
  summarizeIntakeArtifact,
} = require('./test-optimization-intake-analysis')

const DEFAULT_ARTIFACT_PATH = 'dd-test-optimization-intake.json'
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_REPORT_PATH = 'dd-test-optimization-report.html'
const MAX_BODY_SIZE = 50 * 1024 * 1024

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

const EFD_SETTINGS = {
  ...DEFAULT_SETTINGS,
  early_flake_detection: {
    enabled: true,
    slow_test_retries: {
      '5s': 3,
    },
  },
  known_tests_enabled: true,
}

const ATR_SETTINGS = {
  ...DEFAULT_SETTINGS,
  flaky_test_retries_enabled: true,
  flaky_test_retries_count: 1,
}

const TEST_MANAGEMENT_SETTINGS = {
  ...DEFAULT_SETTINGS,
  test_management: {
    enabled: true,
    attempt_to_fix_retries: 3,
  },
}

const DEBUG_ALL_SETTINGS = {
  ...EFD_SETTINGS,
  flaky_test_retries_enabled: true,
  flaky_test_retries_count: 1,
}

const TEST_MANAGEMENT_PRIORITY_SETTINGS = {
  ...DEBUG_ALL_SETTINGS,
  test_management: {
    enabled: true,
    attempt_to_fix_retries: 3,
  },
}

/**
 * Starts the fake Test Optimization intake.
 *
 * @param {object} [options] intake options
 * @param {number} [options.port] port to bind, or 0 for a random port
 * @param {string} [options.host] host to bind
 * @param {string} [options.out] artifact output path
 * @param {string} [options.html] HTML report output path
 * @param {object} [options.knownTests] known tests endpoint response
 * @param {object} [options.settings] settings endpoint response attributes
 * @param {string} [options.settingsMode] settings preset
 * @param {Function} callback called with (error, intake)
 */
function startIntake (options = {}, callback) {
  const host = options.host || DEFAULT_HOST
  const port = options.port === undefined ? 0 : options.port
  const artifact = createArtifact(options)
  const out = path.resolve(options.out || DEFAULT_ARTIFACT_PATH)
  const state = {
    artifact,
    html: resolveReportPath(out, options.html),
    host,
    knownTests: options.knownTests || {},
    out,
    server: undefined,
    settings: options.settings || getSettings(options.settingsMode),
    shutdownToken: randomBytes(16).toString('hex'),
    stopped: false,
    testManagementTests: options.testManagementTests || {},
  }

  const server = http.createServer((req, res) => {
    handleRequest(state, req, res)
  })

  state.server = server

  server.once('error', error => {
    callback(error)
  })

  server.listen(port, host, () => {
    const address = server.address()
    state.port = address.port
    state.url = `http://${host}:${state.port}`
    state.shutdownUrl = `${state.url}/_dd_test_optimization/shutdown?token=${state.shutdownToken}`
    state.artifact.intake.artifactPath = state.out
    state.artifact.intake.htmlReportFileUrl = pathToFileURL(state.html).href
    state.artifact.intake.htmlReportOpenCommand = formatOpenCommand(state.html)
    state.artifact.intake.htmlReportPath = state.html
    state.artifact.intake.port = state.port
    state.artifact.intake.shutdownUrl = state.shutdownUrl
    state.artifact.intake.url = state.url
    writeArtifact(state)
    callback(undefined, state)
  })
}

/**
 * Stops a running fake intake.
 *
 * @param {object} intake running intake state
 * @param {Function} [callback] called when the server closes
 */
function stopIntake (intake, callback = () => {}) {
  if (!markIntakeStopped(intake)) {
    callback()
    return
  }

  intake.server.close(callback)
}

/**
 * Marks an intake as stopped and writes final artifacts.
 *
 * @param {object} intake running intake state
 * @returns {boolean} true when the intake was newly marked stopped
 */
function markIntakeStopped (intake) {
  if (intake.stopped) return false

  intake.stopped = true
  intake.artifact.intake.stoppedAt = new Date().toISOString()
  writeArtifact(intake)
  return true
}

/**
 * Builds an empty intake artifact.
 *
 * @param {object} options intake options
 * @returns {object} artifact
 */
function createArtifact (options = {}) {
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    intake: {
      url: undefined,
      port: undefined,
      settingsMode: options.settingsMode || 'basic-reporting',
    },
    requests: [],
    settings: {
      responses: [],
    },
    knownTests: {
      responses: [],
    },
    testManagement: {
      responses: [],
    },
  }
}

/**
 * Resolves the HTML report path from CLI options.
 *
 * @param {string} out artifact output path
 * @param {string|undefined} html explicit HTML report path
 * @returns {string} HTML report output path
 */
function resolveReportPath (out, html) {
  if (html) return path.resolve(html)

  const parsed = path.parse(out)

  if (parsed.base === DEFAULT_ARTIFACT_PATH) {
    return path.join(parsed.dir, DEFAULT_REPORT_PATH)
  }

  return path.join(parsed.dir, `${parsed.name}.html`)
}

/**
 * Handles an HTTP request to the fake intake or report snapshot.
 *
 * @param {object} state intake state
 * @param {http.IncomingMessage} req HTTP request
 * @param {http.ServerResponse} res HTTP response
 */
function handleRequest (state, req, res) {
  const requestUrl = new URL(req.url, state.url || 'http://127.0.0.1')

  if (req.method === 'GET') {
    handleGetRequest(state, req, res, requestUrl)
    return
  }

  collectBody(req, (error, body) => {
    if (error) {
      sendJson(res, 413, { error: error.message })
      return
    }

    handlePostRequest(state, req, res, requestUrl, body)
  })
}

/**
 * Handles report and metadata GET requests.
 *
 * @param {object} state intake state
 * @param {http.IncomingMessage} req HTTP request
 * @param {http.ServerResponse} res HTTP response
 * @param {URL} requestUrl parsed request URL
 */
function handleGetRequest (state, req, res, requestUrl) {
  const category = categorizePath(req.method, requestUrl.pathname)

  if (requestUrl.pathname === '/_dd_test_optimization/shutdown') {
    handleShutdownRequest(state, res, requestUrl)
    return
  }

  if (requestUrl.pathname === '/' || requestUrl.pathname === '/index.html') {
    sendHtml(res, getReportHtml(state.artifact))
    return
  }

  if (requestUrl.pathname === '/artifact') {
    sendJson(res, 200, state.artifact)
    return
  }

  if (requestUrl.pathname === '/summary') {
    sendJson(res, 200, {
      summary: summarizeIntakeArtifact(state.artifact),
      analysis: analyzeIntakeArtifact(state.artifact),
    })
    return
  }

  if (requestUrl.pathname === '/health') {
    sendJson(res, 200, { ok: true, url: state.url })
    return
  }

  if (requestUrl.pathname === '/info') {
    recordRequest(state, req, requestUrl, category)
    sendJson(res, 200, { endpoints: ['/evp_proxy/v2', '/debugger/v1/input'] })
    return
  }

  sendJson(res, 404, { error: 'Not found' })
}

/**
 * Handles the local shutdown endpoint.
 *
 * @param {object} state intake state
 * @param {http.ServerResponse} res HTTP response
 * @param {URL} requestUrl parsed request URL
 */
function handleShutdownRequest (state, res, requestUrl) {
  if (requestUrl.searchParams.get('token') !== state.shutdownToken) {
    sendJson(res, 403, { error: 'Invalid shutdown token.' })
    return
  }

  markIntakeStopped(state)
  sendJson(res, 200, {
    ok: true,
    artifact: state.out,
    html: state.html,
    htmlFileUrl: state.artifact.intake.htmlReportFileUrl,
    htmlOpenCommand: state.artifact.intake.htmlReportOpenCommand,
  })

  res.once('finish', () => {
    state.server.close(() => {})
  })
}

/**
 * Handles intake POST requests.
 *
 * @param {object} state intake state
 * @param {http.IncomingMessage} req HTTP request
 * @param {http.ServerResponse} res HTTP response
 * @param {URL} requestUrl parsed request URL
 * @param {Buffer} body request body
 */
function handlePostRequest (state, req, res, requestUrl, body) {
  const category = categorizePath(req.method, requestUrl.pathname)
  const decoded = decodeRequestBody(category, body)

  recordRequest(state, req, requestUrl, category, decoded.payload, decoded.error)

  if (category === 'settings') {
    state.artifact.settings.responses.push(state.settings)
    sendJson(res, 200, {
      data: {
        attributes: state.settings,
      },
    })
    return
  }

  if (category === 'known_tests') {
    const response = {
      data: {
        attributes: {
          tests: state.knownTests,
        },
      },
    }
    state.artifact.knownTests.responses.push(response)
    sendJson(res, 200, response)
    return
  }

  if (category === 'skippable') {
    sendJson(res, 200, {
      data: [],
      meta: {
        correlation_id: 'debug-intake',
      },
    })
    return
  }

  if (category === 'test_management') {
    const response = {
      data: {
        attributes: {
          modules: state.testManagementTests,
        },
      },
    }

    state.artifact.testManagement.responses.push({
      request: decoded.payload,
      response,
    })
    sendJson(res, 200, response)
    return
  }

  if (category === 'git_search_commits') {
    sendJson(res, 200, { data: [] })
    return
  }

  if (category === 'git_packfile') {
    res.statusCode = 202
    res.end('')
    return
  }

  sendText(res, 200, 'OK')
}

/**
 * Records a request in the artifact and persists the artifact.
 *
 * @param {object} state intake state
 * @param {http.IncomingMessage} req HTTP request
 * @param {URL} requestUrl parsed request URL
 * @param {string} category request category
 * @param {unknown} payload decoded payload
 * @param {string|undefined} decodeError payload decode error
 */
function recordRequest (state, req, requestUrl, category, payload, decodeError) {
  state.artifact.requests.push({
    id: state.artifact.requests.length + 1,
    receivedAt: new Date().toISOString(),
    method: req.method,
    path: requestUrl.pathname,
    category,
    headers: sanitizeHeaders(req.headers),
    payload,
    decodeError,
  })
  writeArtifact(state)
}

/**
 * Decodes a request body when the endpoint payload format is known.
 *
 * @param {string} category request category
 * @param {Buffer} body request body
 * @returns {{ payload: unknown, error: string|undefined }} decode result
 */
function decodeRequestBody (category, body) {
  if (body.length === 0) {
    return { payload: undefined, error: undefined }
  }

  try {
    if (category === 'citestcycle') {
      return { payload: decodeMsgpack(body), error: undefined }
    }

    if (category === 'settings' || category === 'skippable' || category === 'test_management') {
      return { payload: JSON.parse(body.toString('utf8')), error: undefined }
    }
  } catch (error) {
    return { payload: undefined, error: error.message }
  }

  return { payload: undefined, error: undefined }
}

/**
 * Categorizes a request path into a funnel endpoint.
 *
 * @param {string} method HTTP method
 * @param {string} pathname request path
 * @returns {string} category
 */
function categorizePath (method, pathname) {
  if (method === 'GET' && pathname === '/info') return 'info'
  if (pathname.endsWith('/api/v2/citestcycle')) return 'citestcycle'
  if (pathname.endsWith('/api/v2/citestcov')) return 'citestcov'
  if (pathname.endsWith('/api/v2/cicovreprt')) return 'cicovreprt'
  if (pathname.endsWith('/api/v2/libraries/tests/services/setting')) return 'settings'
  if (pathname.endsWith('/api/v2/ci/libraries/tests')) return 'known_tests'
  if (pathname.endsWith('/api/v2/ci/tests/skippable')) return 'skippable'
  if (pathname.endsWith('/api/v2/test/libraries/test-management/tests')) return 'test_management'
  if (pathname.endsWith('/api/v2/git/repository/search_commits')) return 'git_search_commits'
  if (pathname.endsWith('/api/v2/git/repository/packfile')) return 'git_packfile'
  if (pathname.endsWith('/telemetry/proxy/api/v2/apmtelemetry')) return 'telemetry'
  if (pathname.endsWith('/api/v2/logs') || pathname.endsWith('/debugger/v1/input')) return 'logs'
  return 'other'
}

/**
 * Reads and optionally inflates a request body.
 *
 * @param {http.IncomingMessage} req HTTP request
 * @param {Function} callback called with (error, body)
 */
function collectBody (req, callback) {
  const chunks = []
  let size = 0

  req.on('data', chunk => {
    size += chunk.length
    if (size > MAX_BODY_SIZE) {
      req.destroy(new Error('Request body is too large for the debug intake.'))
      return
    }
    chunks.push(chunk)
  })

  req.once('error', error => {
    callback(error)
  })

  req.once('end', () => {
    const body = Buffer.concat(chunks)
    if (req.headers['content-encoding'] === 'gzip') {
      zlib.gunzip(body, callback)
      return
    }

    callback(undefined, body)
  })
}

/**
 * Sanitizes headers before writing artifacts.
 *
 * @param {object} headers request headers
 * @returns {object} sanitized headers
 */
function sanitizeHeaders (headers) {
  const sanitized = {}

  for (const [name, value] of Object.entries(headers)) {
    sanitized[name] = /api-key|token|authorization/i.test(name) ? '<redacted>' : value
  }

  return sanitized
}

/**
 * Writes the JSON artifact and static HTML report to disk.
 *
 * @param {object} state intake state
 */
function writeArtifact (state) {
  fs.mkdirSync(path.dirname(state.out), { recursive: true })
  fs.writeFileSync(state.out, `${JSON.stringify(state.artifact, jsonReplacer, 2)}\n`)
  fs.mkdirSync(path.dirname(state.html), { recursive: true })
  fs.writeFileSync(state.html, getReportHtml(state.artifact))
}

/**
 * JSON replacer for BigInt values.
 *
 * @param {string} _key JSON key
 * @param {unknown} value JSON value
 * @returns {unknown} serializable value
 */
function jsonReplacer (_key, value) {
  return typeof value === 'bigint' ? value.toString() : value
}

/**
 * Sends a JSON response.
 *
 * @param {http.ServerResponse} res HTTP response
 * @param {number} statusCode response status
 * @param {object} payload JSON payload
 */
function sendJson (res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(payload, jsonReplacer))
}

/**
 * Sends a text response.
 *
 * @param {http.ServerResponse} res HTTP response
 * @param {number} statusCode response status
 * @param {string} text response body
 */
function sendText (res, statusCode, text) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'text/plain')
  res.end(text)
}

/**
 * Sends an HTML response.
 *
 * @param {http.ServerResponse} res HTTP response
 * @param {string} html response body
 */
function sendHtml (res, html) {
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/html')
  res.end(html)
}

/**
 * Decodes the subset of MessagePack used by Test Optimization payloads.
 *
 * @param {Buffer} buffer msgpack buffer
 * @returns {unknown} decoded payload
 */
function decodeMsgpack (buffer) {
  const state = { buffer, offset: 0 }
  return readMsgpackValue(state)
}

/**
 * Reads a MessagePack value from the decoder state.
 *
 * @param {object} state decoder state
 * @returns {unknown} decoded value
 */
function readMsgpackValue (state) {
  const byte = readUInt8(state)

  if (byte <= 0x7F) return byte
  if (byte >= 0xE0) return byte - 0x1_00
  if ((byte & 0xE0) === 0xA0) return readString(state, byte & 0x1F)
  if ((byte & 0xF0) === 0x90) return readArray(state, byte & 0x0F)
  if ((byte & 0xF0) === 0x80) return readMap(state, byte & 0x0F)

  switch (byte) {
    case 0xC0:
      return null
    case 0xC2:
      return false
    case 0xC3:
      return true
    case 0xC4:
      return readBinary(state, readUInt8(state))
    case 0xC5:
      return readBinary(state, readUInt16(state))
    case 0xC6:
      return readBinary(state, readUInt32(state))
    case 0xCA:
      return readFloat(state)
    case 0xCB:
      return readDouble(state)
    case 0xCC:
      return readUInt8(state)
    case 0xCD:
      return readUInt16(state)
    case 0xCE:
      return readUInt32(state)
    case 0xCF:
      return readUInt64(state)
    case 0xD0:
      return readInt8(state)
    case 0xD1:
      return readInt16(state)
    case 0xD2:
      return readInt32(state)
    case 0xD3:
      return readInt64(state)
    case 0xD9:
      return readString(state, readUInt8(state))
    case 0xDA:
      return readString(state, readUInt16(state))
    case 0xDB:
      return readString(state, readUInt32(state))
    case 0xDC:
      return readArray(state, readUInt16(state))
    case 0xDD:
      return readArray(state, readUInt32(state))
    case 0xDE:
      return readMap(state, readUInt16(state))
    case 0xDF:
      return readMap(state, readUInt32(state))
    default:
      throw new Error(`Unsupported msgpack byte 0x${byte.toString(16)}`)
  }
}

/**
 * Reads a MessagePack array.
 *
 * @param {object} state decoder state
 * @param {number} length array length
 * @returns {Array<unknown>} decoded array
 */
function readArray (state, length) {
  const array = []
  for (let i = 0; i < length; i++) {
    array.push(readMsgpackValue(state))
  }
  return array
}

/**
 * Reads a MessagePack map.
 *
 * @param {object} state decoder state
 * @param {number} length map length
 * @returns {object} decoded map
 */
function readMap (state, length) {
  const map = {}
  for (let i = 0; i < length; i++) {
    const key = String(readMsgpackValue(state))
    map[key] = readMsgpackValue(state)
  }
  return map
}

/**
 * Reads a UTF-8 string.
 *
 * @param {object} state decoder state
 * @param {number} length string length
 * @returns {string} decoded string
 */
function readString (state, length) {
  const start = state.offset
  state.offset += length
  return state.buffer.toString('utf8', start, state.offset)
}

/**
 * Reads binary data.
 *
 * @param {object} state decoder state
 * @param {number} length binary length
 * @returns {string} base64-encoded binary
 */
function readBinary (state, length) {
  const start = state.offset
  state.offset += length
  return state.buffer.subarray(start, state.offset).toString('base64')
}

/**
 * Reads an unsigned 8-bit integer.
 *
 * @param {object} state decoder state
 * @returns {number} integer
 */
function readUInt8 (state) {
  const value = state.buffer.readUInt8(state.offset)
  state.offset += 1
  return value
}

/**
 * Reads an unsigned 16-bit integer.
 *
 * @param {object} state decoder state
 * @returns {number} integer
 */
function readUInt16 (state) {
  const value = state.buffer.readUInt16BE(state.offset)
  state.offset += 2
  return value
}

/**
 * Reads an unsigned 32-bit integer.
 *
 * @param {object} state decoder state
 * @returns {number} integer
 */
function readUInt32 (state) {
  const value = state.buffer.readUInt32BE(state.offset)
  state.offset += 4
  return value
}

/**
 * Reads an unsigned 64-bit integer.
 *
 * @param {object} state decoder state
 * @returns {number|bigint} integer
 */
function readUInt64 (state) {
  const value = state.buffer.readBigUInt64BE(state.offset)
  state.offset += 8
  return Number.isSafeInteger(Number(value)) ? Number(value) : value
}

/**
 * Reads a signed 8-bit integer.
 *
 * @param {object} state decoder state
 * @returns {number} integer
 */
function readInt8 (state) {
  const value = state.buffer.readInt8(state.offset)
  state.offset += 1
  return value
}

/**
 * Reads a signed 16-bit integer.
 *
 * @param {object} state decoder state
 * @returns {number} integer
 */
function readInt16 (state) {
  const value = state.buffer.readInt16BE(state.offset)
  state.offset += 2
  return value
}

/**
 * Reads a signed 32-bit integer.
 *
 * @param {object} state decoder state
 * @returns {number} integer
 */
function readInt32 (state) {
  const value = state.buffer.readInt32BE(state.offset)
  state.offset += 4
  return value
}

/**
 * Reads a signed 64-bit integer.
 *
 * @param {object} state decoder state
 * @returns {number|bigint} integer
 */
function readInt64 (state) {
  const value = state.buffer.readBigInt64BE(state.offset)
  state.offset += 8
  return Number.isSafeInteger(Number(value)) ? Number(value) : value
}

/**
 * Reads a 32-bit float.
 *
 * @param {object} state decoder state
 * @returns {number} float
 */
function readFloat (state) {
  const value = state.buffer.readFloatBE(state.offset)
  state.offset += 4
  return value
}

/**
 * Reads a 64-bit float.
 *
 * @param {object} state decoder state
 * @returns {number} float
 */
function readDouble (state) {
  const value = state.buffer.readDoubleBE(state.offset)
  state.offset += 8
  return value
}

/**
 * Parses CLI arguments.
 *
 * @param {string[]} args command-line arguments
 * @returns {object} parsed options
 */
function parseArgs (args) {
  const options = {
    host: DEFAULT_HOST,
    out: DEFAULT_ARTIFACT_PATH,
    port: 0,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--port') {
      options.port = Number(args[++i])
    } else if (arg.startsWith('--port=')) {
      options.port = Number(arg.slice('--port='.length))
    } else if (arg === '--host') {
      options.host = args[++i]
    } else if (arg.startsWith('--host=')) {
      options.host = arg.slice('--host='.length)
    } else if (arg === '--out') {
      options.out = args[++i]
    } else if (arg.startsWith('--out=')) {
      options.out = arg.slice('--out='.length)
    } else if (arg === '--html') {
      options.html = args[++i]
    } else if (arg.startsWith('--html=')) {
      options.html = arg.slice('--html='.length)
    } else if (arg === '--settings-mode') {
      options.settingsMode = args[++i]
    } else if (arg.startsWith('--settings-mode=')) {
      options.settingsMode = arg.slice('--settings-mode='.length)
    } else if (arg === '--known-tests') {
      options.knownTests = normalizeKnownTests(readJsonFile(args[++i]))
    } else if (arg.startsWith('--known-tests=')) {
      options.knownTests = normalizeKnownTests(readJsonFile(arg.slice('--known-tests='.length)))
    } else if (arg === '--test-management-tests') {
      options.testManagementTests = normalizeTestManagementTests(readJsonFile(args[++i]))
    } else if (arg.startsWith('--test-management-tests=')) {
      options.testManagementTests = normalizeTestManagementTests(
        readJsonFile(arg.slice('--test-management-tests='.length))
      )
    } else {
      options.unknown = arg
    }
  }

  return options
}

/**
 * Returns CLI help text.
 *
 * @returns {string} help text
 */
function getHelpText () {
  return [
    'Usage: dd-trace-ci-intake [--port <port>] [--host <host>] [--out <artifact.json>] [--html <report.html>]',
    '',
    'Runs a local fake Datadog Test Optimization intake and writes a static HTML report.',
    'The command prints a shutdown URL that cleanly flushes final artifacts without Ctrl-C.',
    '',
    'Options:',
    '  --settings-mode basic-reporting  Default settings: basic reporting only.',
    '  --settings-mode atr              Enable Auto Test Retries settings.',
    '  --settings-mode efd              Enable known tests and Early Flake Detection settings.',
    '  --settings-mode debug-all        Enable known tests, EFD, and Auto Test Retries settings.',
    '  --settings-mode tm-disabled      Enable Test Management settings for disabled-test checks.',
    '  --settings-mode tm-quarantined   Enable Test Management settings for quarantined-test checks.',
    '  --settings-mode tm-attempt-to-fix  Enable Test Management settings for attempt-to-fix checks.',
    '  --settings-mode tm-attempt-to-fix-priority  Enable TM, EFD, and Auto Test Retries for priority checks.',
    '  --known-tests <file>             Known tests JSON to return from /api/v2/ci/libraries/tests.',
    '  --test-management-tests <file>   Test Management modules JSON for /api/v2/test/libraries/test-management/tests.',
    '',
    'Point tests at it with:',
    '',
    '  DD_API_KEY=debug \\',
    '  DD_SERVICE=dd-test-optimization-debug \\',
    '  DD_CIVISIBILITY_AGENTLESS_ENABLED=1 \\',
    '  DD_CIVISIBILITY_AGENTLESS_URL=http://127.0.0.1:<port> \\',
    '  NODE_OPTIONS="-r dd-trace/ci/init" \\',
    '  <test command>',
  ].join('\n')
}

/**
 * Gets fake settings for a settings mode.
 *
 * @param {string|undefined} settingsMode settings mode
 * @returns {object} settings response attributes
 */
function getSettings (settingsMode) {
  if (settingsMode === 'atr') return ATR_SETTINGS
  if (settingsMode === 'debug-all') return DEBUG_ALL_SETTINGS
  if (settingsMode === 'efd') return EFD_SETTINGS
  if (
    settingsMode === 'tm-disabled' ||
    settingsMode === 'tm-quarantined' ||
    settingsMode === 'tm-attempt-to-fix'
  ) {
    return TEST_MANAGEMENT_SETTINGS
  }
  if (settingsMode === 'tm-attempt-to-fix-priority') return TEST_MANAGEMENT_PRIORITY_SETTINGS
  return DEFAULT_SETTINGS
}

/**
 * Reads a JSON file.
 *
 * @param {string} file JSON file path
 * @returns {unknown} parsed JSON
 */
function readJsonFile (file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'))
}

/**
 * Normalizes known tests input to the endpoint tests object.
 *
 * @param {unknown} value parsed known tests JSON
 * @returns {object} known tests object
 */
function normalizeKnownTests (value) {
  if (value?.data?.attributes?.tests && typeof value.data.attributes.tests === 'object') {
    return value.data.attributes.tests
  }

  if (value && typeof value === 'object') return value

  return {}
}

/**
 * Normalizes Test Management input to the endpoint modules object.
 *
 * @param {unknown} value parsed Test Management tests JSON
 * @returns {object} Test Management modules object
 */
function normalizeTestManagementTests (value) {
  if (value?.data?.attributes?.modules && typeof value.data.attributes.modules === 'object') {
    return value.data.attributes.modules
  }

  if (value?.modules && typeof value.modules === 'object') return value.modules
  if (value && typeof value === 'object') return value

  return {}
}

/**
 * Returns the static report HTML.
 *
 * @param {object} artifact fake intake artifact
 * @returns {string} HTML
 */
function getReportHtml (artifact) {
  const analysis = analyzeIntakeArtifact(artifact)
  const summary = analysis.summary
  const findings = analysis.findings.length > 0
    ? analysis.findings.map(renderFindingRow).join('\n')
    : renderFindingRow({
      status: 'ok',
      stage: 'No findings',
      observation: 'No fixed-rule findings were produced.',
      cause: 'The selected test command did not hit a known failure stage.',
      fix: 'Use agent judgment for repository-specific anomalies.',
    })
  const endpoints = JSON.stringify(summary.endpoints, null, 2)
  const createdAt = artifact.createdAt || '-'
  const stoppedAt = artifact.intake?.stoppedAt || 'Intake still running when this report was written'

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Test Optimization Debug Report</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f7fa;
      --card: #ffffff;
      --ink: #1f2933;
      --muted: #667085;
      --line: #d7dde5;
      --soft: #eef2f6;
      --blue: #1769aa;
      --green: #167f59;
      --orange: #b35c00;
      --red: #bd2c3b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: Arial, "Helvetica Neue", Helvetica, sans-serif;
      line-height: 1.5;
    }
    main {
      margin: 0 auto;
      max-width: 1080px;
      padding: 32px 24px 48px;
    }
    header {
      border-bottom: 1px solid var(--line);
      margin-bottom: 24px;
      padding-bottom: 18px;
    }
    h1 {
      font-size: 30px;
      letter-spacing: 0;
      line-height: 1.2;
      margin: 0 0 8px;
    }
    h2 {
      font-size: 18px;
      letter-spacing: 0;
      margin: 30px 0 12px;
    }
    .muted {
      color: var(--muted);
      margin: 0;
    }
    .stage {
      align-items: center;
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 6px;
      display: flex;
      justify-content: space-between;
      gap: 16px;
      margin: 18px 0;
      padding: 16px 18px;
    }
    .stage strong {
      font-size: 20px;
    }
    .summary-grid {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(auto-fit, minmax(138px, 1fr));
    }
    .metric {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 14px;
    }
    .metric .label {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
    }
    .metric .value {
      font-size: 28px;
      font-weight: 700;
      margin-top: 4px;
    }
    .table-wrap {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 6px;
      overflow: auto;
    }
    table {
      border-collapse: collapse;
      min-width: 760px;
      width: 100%;
    }
    th,
    td {
      border-bottom: 1px solid var(--line);
      padding: 12px 14px;
      text-align: left;
      vertical-align: top;
    }
    th {
      background: var(--soft);
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
    }
    tr:last-child td {
      border-bottom: 0;
    }
    .finding-head {
      display: grid;
      gap: 6px;
    }
    .badge {
      border-radius: 4px;
      color: #fff;
      display: inline-block;
      font-size: 11px;
      font-weight: 700;
      line-height: 1;
      padding: 4px 7px;
      text-transform: uppercase;
      width: fit-content;
    }
    .ok { background: var(--green); }
    .info { background: var(--blue); }
    .warning { background: var(--orange); }
    .error { background: var(--red); }
    pre {
      background: #111827;
      border-radius: 6px;
      color: #f9fafb;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 13px;
      margin: 0;
      overflow: auto;
      padding: 14px;
      white-space: pre-wrap;
    }
    .metadata {
      color: var(--muted);
      display: grid;
      gap: 6px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      margin-top: 16px;
    }
    .metadata span {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 10px 12px;
    }
    @media (max-width: 780px) {
      main {
        padding: 24px 16px 36px;
      }
      .stage {
        display: block;
      }
      .summary-grid,
      .metadata {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Test Optimization debug report</h1>
      <p class="muted">Static snapshot generated by the local fake intake.</p>
    </header>

    <section class="stage" aria-label="Primary stage">
      <div>
        <p class="muted">Primary stage</p>
        <strong>${escapeHtml(analysis.primaryStage)}</strong>
      </div>
      <p class="muted">Requests observed: ${escapeHtml(summary.requestCount)}</p>
    </section>

    <section class="summary-grid" aria-label="Summary metrics">
      ${renderMetric('Requests', summary.requestCount)}
      ${renderMetric('citestcycle', summary.citestcycle.payloadCount)}
      ${renderMetric('Sessions', summary.events.counts.test_session_end)}
      ${renderMetric('Modules', summary.events.counts.test_module_end)}
      ${renderMetric('Suites', summary.events.counts.test_suite_end)}
      ${renderMetric('Tests', summary.events.counts.test)}
      ${renderMetric('Decode errors', summary.decodeErrors.length)}
    </section>

    <h2>Findings</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Stage</th>
            <th>Observation</th>
            <th>Cause</th>
            <th>Fix</th>
          </tr>
        </thead>
        <tbody>${findings}</tbody>
      </table>
    </div>

    <h2>Endpoint counts</h2>
    <pre>${escapeHtml(endpoints)}</pre>

    <div class="metadata">
      <span>Created: ${escapeHtml(createdAt)}</span>
      <span>Stopped: ${escapeHtml(stoppedAt)}</span>
    </div>
  </main>
</body>
</html>`
}

/**
 * Renders a report metric.
 *
 * @param {string} label metric label
 * @param {number} value metric value
 * @returns {string} HTML
 */
function renderMetric (label, value) {
  return [
    '<div class="metric">',
    `<div class="label">${escapeHtml(label)}</div>`,
    `<div class="value">${escapeHtml(value)}</div>`,
    '</div>',
  ].join('')
}

/**
 * Renders a finding table row.
 *
 * @param {object} item finding
 * @returns {string} HTML
 */
function renderFindingRow (item) {
  return [
    '<tr>',
    '<td>',
    '<div class="finding-head">',
    `<span class="badge ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span>`,
    `<span class="stage">${escapeHtml(item.stage)}</span>`,
    '</div>',
    '</td>',
    `<td>${escapeHtml(item.observation)}</td>`,
    `<td>${escapeHtml(item.cause)}</td>`,
    `<td>${escapeHtml(item.fix)}</td>`,
    '</tr>',
  ].join('')
}

/**
 * Escapes text for HTML output.
 *
 * @param {unknown} value value to escape
 * @returns {string} escaped value
 */
function escapeHtml (value) {
  return String(value).replaceAll(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]))
}

/**
 * Formats the platform-specific command to open a local file.
 *
 * @param {string} file file path
 * @returns {string} shell command
 */
function formatOpenCommand (file) {
  if (process.platform === 'darwin') {
    return [
      `open -a ${shellQuote('Google Chrome')} ${shellQuote(file)}`,
      `open -a Chromium ${shellQuote(file)}`,
      `open -a Safari ${shellQuote(file)}`,
      `open ${shellQuote(file)}`,
    ].join(' || ')
  }

  if (process.platform === 'win32') {
    return [
      `start "" ${windowsQuote(file)}`,
      `explorer.exe ${windowsQuote(file)}`,
    ].join(' || ')
  }

  return [
    `google-chrome ${shellQuote(file)}`,
    `chromium ${shellQuote(file)}`,
    `chromium-browser ${shellQuote(file)}`,
    `firefox ${shellQuote(file)}`,
    `xdg-open ${shellQuote(file)}`,
  ].join(' || ')
}

/**
 * Quotes a shell argument.
 *
 * @param {string} value argument value
 * @returns {string} quoted argument
 */
function shellQuote (value) {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`
}

/**
 * Quotes a Windows shell argument.
 *
 * @param {string} value argument value
 * @returns {string} quoted argument
 */
function windowsQuote (value) {
  return `"${value.replaceAll('"', String.raw`\"`)}"`
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2))

  if (options.help) {
    console.log(getHelpText())
  } else if (options.unknown) {
    console.error(`Unknown argument: ${options.unknown}`)
    console.error(getHelpText())
    process.exitCode = 1
  } else {
    startIntake(options, (error, intake) => {
      if (error) {
        console.error(error.message)
        process.exitCode = 1
        return
      }

      console.log('Datadog Test Optimization fake intake is running')
      console.log(`Intake URL: ${intake.url}`)
      console.log(`Artifact: ${intake.out}`)
      console.log(`HTML report: ${pathToFileURL(intake.html).href}`)
      console.log(`HTML report path: ${intake.html}`)
      console.log(`Open HTML report command: ${formatOpenCommand(intake.html)}`)
      console.log(`Shutdown URL: ${intake.shutdownUrl}`)
      console.log('')
      console.log('Run tests with:')
      console.log('  DD_API_KEY=debug \\')
      console.log('  DD_SERVICE=dd-test-optimization-debug \\')
      console.log('  DD_CIVISIBILITY_AGENTLESS_ENABLED=1 \\')
      console.log(`  DD_CIVISIBILITY_AGENTLESS_URL=${intake.url} \\`)
      console.log('  DD_INSTRUMENTATION_TELEMETRY_ENABLED=false \\')
      console.log('  NODE_OPTIONS="-r dd-trace/ci/init" \\')
      console.log('  <test command>')

      process.once('SIGINT', () => {
        stopIntake(intake, () => {
          process.exitCode = 0
        })
      })
      process.once('SIGTERM', () => {
        stopIntake(intake, () => {
          process.exitCode = 0
        })
      })
    })
  }
}

module.exports = {
  createArtifact,
  decodeMsgpack,
  getSettings,
  normalizeKnownTests,
  normalizeTestManagementTests,
  parseArgs,
  startIntake,
  stopIntake,
}
