const express = require('express')
const bodyParser = require('body-parser')
const msgpack = require('msgpack-lite')
const codec = msgpack.createCodec({ int64: true })
const http = require('http')
const multer = require('multer')
const upload = multer()

const { FakeAgent } = require('./helpers')

const DEFAULT_SETTINGS = {
  code_coverage: true,
  tests_skipping: true
}

const DEFAULT_SUITES_TO_SKIP = []
const DEFAULT_GIT_UPLOAD_STATUS = 200
const DEFAULT_INFO_RESPONSE = {
  endpoints: ['/evp_proxy/v2']
}

let settings = DEFAULT_SETTINGS
let suitesToSkip = DEFAULT_SUITES_TO_SKIP
let gitUploadStatus = DEFAULT_GIT_UPLOAD_STATUS
let infoResponse = DEFAULT_INFO_RESPONSE

class FakeCiVisIntake extends FakeAgent {
  setInfoResponse (newInfoResponse) {
    infoResponse = newInfoResponse
  }

  setGitUploadStatus (newStatus) {
    gitUploadStatus = newStatus
  }

  setSuitesToSkip (newSuitesToSkip) {
    suitesToSkip = newSuitesToSkip
  }

  setSettings (newSettings) {
    settings = newSettings
  }

  async start () {
    const app = express()
    app.use(bodyParser.raw({ limit: Infinity, type: 'application/msgpack' }))

    app.put('/v0.4/traces', (req, res) => {
      if (req.body.length === 0) return res.status(200).send()
      res.status(200).send({ rate_by_service: { 'service:,env:': 1 } })
      this.emit('message', {
        headers: req.headers,
        payload: msgpack.decode(req.body, { codec }),
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

    app.post(['/api/v2/citestcycle', '/evp_proxy/v2/api/v2/citestcycle'], (req, res) => {
      res.status(200).send('OK')
      this.emit('message', {
        headers: req.headers,
        payload: msgpack.decode(req.body, { codec }),
        url: req.url
      })
    })

    app.post([
      '/api/v2/git/repository/search_commits',
      '/evp_proxy/v2/api/v2/git/repository/search_commits'
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
      '/evp_proxy/v2/api/v2/git/repository/packfile'
    ], (req, res) => {
      res.status(202).send('')
      this.emit('message', {
        headers: req.headers,
        url: req.url
      })
    })

    app.post([
      '/api/v2/citestcov',
      '/evp_proxy/v2/api/v2/citestcov'
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
      '/evp_proxy/v2/api/v2/libraries/tests/services/setting'
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
      '/evp_proxy/v2/api/v2/ci/tests/skippable'
    ], (req, res) => {
      res.status(200).send(JSON.stringify({
        data: suitesToSkip
      }))
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

  async stop () {
    await super.stop()
    settings = DEFAULT_SETTINGS
    suitesToSkip = DEFAULT_SUITES_TO_SKIP
    gitUploadStatus = DEFAULT_GIT_UPLOAD_STATUS
    infoResponse = DEFAULT_INFO_RESPONSE
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
          clearInterval(timeoutId)
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
