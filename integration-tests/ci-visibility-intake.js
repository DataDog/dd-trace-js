'use strict'

const express = require('express')
const bodyParser = require('body-parser')
const msgpack = require('@msgpack/msgpack')
const http = require('http')
const multer = require('multer')
const upload = multer()
const zlib = require('zlib')

const { FakeAgent } = require('./helpers')

const DEFAULT_SETTINGS = {
  code_coverage: true,
  tests_skipping: true,
  itr_enabled: true,
  require_git: false,
  early_flake_detection: {
    enabled: false,
    slow_test_retries: {
      '5s': 3
    }
  },
  flaky_test_retries_enabled: false,
  di_enabled: false,
  known_tests_enabled: false,
  test_management: {
    enabled: false
  },
  impacted_tests_enabled: false
}

const DEFAULT_SUITES_TO_SKIP = []
const DEFAULT_GIT_UPLOAD_STATUS = 200
const DEFAULT_KNOWN_TESTS_RESPONSE_STATUS = 200
const DEFAULT_INFO_RESPONSE = {
  endpoints: ['/evp_proxy/v2', '/debugger/v1/input']
}
const DEFAULT_CORRELATION_ID = '1234'
const DEFAULT_KNOWN_TESTS = ['test-suite1.js.test-name1', 'test-suite2.js.test-name2']

const DEFAULT_TEST_MANAGEMENT_TESTS = {}
const DEFAULT_TEST_MANAGEMENT_TESTS_RESPONSE_STATUS = 200

let settings = DEFAULT_SETTINGS
let suitesToSkip = DEFAULT_SUITES_TO_SKIP
let gitUploadStatus = DEFAULT_GIT_UPLOAD_STATUS
let infoResponse = DEFAULT_INFO_RESPONSE
let correlationId = DEFAULT_CORRELATION_ID
let knownTests = DEFAULT_KNOWN_TESTS
let knownTestsStatusCode = DEFAULT_KNOWN_TESTS_RESPONSE_STATUS
let waitingTime = 0
let testManagementResponse = DEFAULT_TEST_MANAGEMENT_TESTS
let testManagementResponseStatusCode = DEFAULT_TEST_MANAGEMENT_TESTS_RESPONSE_STATUS

class FakeCiVisIntake extends FakeAgent {
  setKnownTestsResponseCode (statusCode) {
    knownTestsStatusCode = statusCode
  }

  setKnownTests (newKnownTestsResponse) {
    knownTests = newKnownTestsResponse
  }

  setInfoResponse (newInfoResponse) {
    infoResponse = newInfoResponse
  }

  setGitUploadStatus (newStatus) {
    gitUploadStatus = newStatus
  }

  setSuitesToSkip (newSuitesToSkip) {
    suitesToSkip = newSuitesToSkip
  }

  setItrCorrelationId (newCorrelationId) {
    correlationId = newCorrelationId
  }

  setSettings (newSettings) {
    settings = newSettings
  }

  setWaitingTime (newWaitingTime) {
    waitingTime = newWaitingTime
  }

  setTestManagementTests (newTestManagementTests) {
    testManagementResponse = newTestManagementTests
  }

  setTestManagementTestsResponseCode (newStatusCode) {
    testManagementResponseStatusCode = newStatusCode
  }

  async start () {
    const app = express()
    app.use(bodyParser.raw({ limit: Infinity, type: 'application/msgpack' }))

    app.put('/v0.4/traces', (req, res) => {
      if (req.body.length === 0) return res.status(200).send()
      res.status(200).send({ rate_by_service: { 'service:,env:': 1 } })
      this.emit('message', {
        headers: req.headers,
        payload: msgpack.decode(req.body, { useBigInt64: true }),
        url: req.url
      })
    })

    app.get('/info', (req, res) => {
      res.status(200).send(JSON.stringify(infoResponse))
      this.emit('message', {
        headers: req.headers,
        url: req.url
      })
    })

    // It can be slowed down with setWaitingTime
    app.post(['/api/v2/citestcycle', '/evp_proxy/:version/api/v2/citestcycle'], (req, res) => {
      this.waitingTimeoutId = setTimeout(() => {
        res.status(200).send('OK')
        this.emit('message', {
          headers: req.headers,
          payload: msgpack.decode(req.body, { useBigInt64: true }),
          url: req.url
        })
      }, waitingTime || 0)
    })

    app.post([
      '/api/v2/git/repository/search_commits',
      '/evp_proxy/:version/api/v2/git/repository/search_commits'
    ], (req, res) => {
      res.status(gitUploadStatus).send(JSON.stringify({ data: [] }))
      this.emit('message', {
        headers: req.headers,
        payload: req.body,
        url: req.url
      })
    })

    app.post([
      '/api/v2/git/repository/packfile',
      '/evp_proxy/:version/api/v2/git/repository/packfile'
    ], (req, res) => {
      res.status(202).send('')
      this.emit('message', {
        headers: req.headers,
        url: req.url
      })
    })

    app.post([
      '/api/v2/citestcov',
      '/evp_proxy/:version/api/v2/citestcov'
    ], upload.any(), (req, res) => {
      res.status(200).send('OK')

      const coveragePayloads = req.files
        .filter((file) => file.fieldname !== 'event')
        .map((file) => {
          return {
            name: file.fieldname,
            type: file.mimetype,
            filename: file.originalname,
            content: msgpack.decode(file.buffer)
          }
        })

      this.emit('message', {
        headers: req.headers,
        payload: coveragePayloads,
        url: req.url
      })
    })

    app.post([
      '/api/v2/libraries/tests/services/setting',
      '/evp_proxy/:version/api/v2/libraries/tests/services/setting'
    ], (req, res) => {
      res.status(200).send(JSON.stringify({
        data: {
          attributes: settings
        }
      }))
      this.emit('message', {
        headers: req.headers,
        url: req.url
      })
    })

    app.post([
      '/api/v2/ci/tests/skippable',
      '/evp_proxy/:version/api/v2/ci/tests/skippable'
    ], (req, res) => {
      res.status(200).send(JSON.stringify({
        data: suitesToSkip,
        meta: {
          correlation_id: correlationId
        }
      }))
      this.emit('message', {
        headers: req.headers,
        url: req.url
      })
    })

    app.post([
      '/api/v2/ci/libraries/tests',
      '/evp_proxy/:version/api/v2/ci/libraries/tests'
    ], (req, res) => {
      // The endpoint returns compressed data if 'accept-encoding' is set to 'gzip'
      const isGzip = req.headers['accept-encoding'] === 'gzip'
      const data = JSON.stringify({
        data: {
          attributes: {
            tests: knownTests
          }
        }
      })
      res.setHeader('content-type', 'application/json')
      if (isGzip) {
        res.setHeader('content-encoding', 'gzip')
      }
      res.status(knownTestsStatusCode).send(isGzip ? zlib.gzipSync(data) : data)
      this.emit('message', {
        headers: req.headers,
        url: req.url
      })
    })

    app.post([
      '/api/v2/logs',
      '/debugger/v1/input'
    ], express.json(), (req, res) => {
      res.status(200).send('OK')
      this.emit('message', {
        headers: req.headers,
        url: req.url,
        logMessage: req.body
      })
    })

    app.post([
      '/api/v2/test/libraries/test-management/tests',
      '/evp_proxy/:version/api/v2/test/libraries/test-management/tests'
    ], (req, res) => {
      res.setHeader('content-type', 'application/json')
      const data = JSON.stringify({
        data: {
          attributes: {
            modules: testManagementResponse
          }
        }
      })
      res.status(testManagementResponseStatusCode).send(data)
      this.emit('message', {
        headers: req.headers,
        url: req.url
      })
    })

    return new Promise((resolve, reject) => {
      const timeoutObj = setTimeout(() => {
        reject(new Error('Intake timed out starting up'))
      }, 10000)
      this.server = http.createServer(app)
      this.server.on('error', reject)
      this.server.listen(this.port, () => {
        this.port = this.server.address().port
        clearTimeout(timeoutObj)
        resolve(this)
      })
    })
  }

  stop () {
    settings = DEFAULT_SETTINGS
    suitesToSkip = DEFAULT_SUITES_TO_SKIP
    gitUploadStatus = DEFAULT_GIT_UPLOAD_STATUS
    knownTestsStatusCode = DEFAULT_KNOWN_TESTS_RESPONSE_STATUS
    infoResponse = DEFAULT_INFO_RESPONSE
    testManagementResponseStatusCode = DEFAULT_TEST_MANAGEMENT_TESTS_RESPONSE_STATUS
    testManagementResponse = DEFAULT_TEST_MANAGEMENT_TESTS
    this.removeAllListeners()
    if (this.waitingTimeoutId) {
      clearTimeout(this.waitingTimeoutId)
    }
    waitingTime = 0
    return super.stop()
  }

  // Similar to gatherPayloads but resolves if enough payloads have been gathered
  // to make the assertions pass. It times out after maxGatheringTime so it should
  // always be faster or as fast as gatherPayloads
  gatherPayloadsMaxTimeout (payloadMatch, onPayload, maxGatheringTime = 15000) {
    const payloads = []
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        try {
          onPayload(payloads)
          resolve()
        } catch (e) {
          reject(e)
        } finally {
          this.off('message', messageHandler)
        }
      }, maxGatheringTime)
      const messageHandler = (message) => {
        if (!payloadMatch || payloadMatch(message)) {
          payloads.push(message)
          try {
            onPayload(payloads)
            clearTimeout(timeoutId)
            this.off('message', messageHandler)
            resolve()
          } catch (e) {
            // we'll try again when a new payload arrives
          }
        }
      }
      this.on('message', messageHandler)
    })
  }

  gatherPayloads (payloadMatch, gatheringTime = 15000) {
    const payloads = []
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        this.off('message', messageHandler)
        if (payloads.length === 0) {
          reject(new Error('No payloads were received'))
        } else {
          resolve(payloads)
        }
      }, gatheringTime)
      const messageHandler = (message) => {
        if (!payloadMatch || payloadMatch(message)) {
          payloads.push(message)
        }
      }
      this.on('message', messageHandler)
    })
  }

  payloadReceived (payloadMatch, timeout) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.off('message', messageHandler)
        reject(new Error('Timeout'))
      }, timeout || 15000)
      const messageHandler = (message) => {
        if (!payloadMatch || payloadMatch(message)) {
          clearTimeout(timeoutId)
          resolve(message)
          this.off('message', messageHandler)
        }
      }
      this.on('message', messageHandler)
    })
  }

  assertPayloadReceived (fn, messageMatch, timeout) {
    let resultResolve
    let resultReject
    let error

    const timeoutObj = setTimeout(() => {
      resultReject([error, new Error('timeout')])
    }, timeout || 15000)

    const messageHandler = (message) => {
      if (!messageMatch || messageMatch(message)) {
        try {
          fn(message)
          resultResolve()
        } catch (e) {
          resultReject(e)
        }
        this.off('message', messageHandler)
      }
    }
    this.on('message', messageHandler)

    return new Promise((resolve, reject) => {
      resultResolve = () => {
        clearTimeout(timeoutObj)
        resolve()
      }
      resultReject = (e) => {
        clearTimeout(timeoutObj)
        reject(e)
      }
    })
  }
}

module.exports = { FakeCiVisIntake }
