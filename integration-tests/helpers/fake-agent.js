'use strict'

const { createHash } = require('crypto')
const EventEmitter = require('events')
const http = require('http')
const express = require('express')
const bodyParser = require('body-parser')
const msgpack = require('msgpack-lite')
const codec = msgpack.createCodec({ int64: true })
const upload = require('multer')()

module.exports = class FakeAgent extends EventEmitter {
  constructor (port = 0) {
    super()
    this.port = port
    this._rc_files = []
  }

  async start () {
    return new Promise((resolve, reject) => {
      const timeoutObj = setTimeout(() => {
        reject(new Error('agent timed out starting up'))
      }, 10000)
      this.server = http.createServer(buildExpressServer(this))
      this.server.on('error', reject)
      this.server.listen(this.port, () => {
        this.port = this.server.address().port
        clearTimeout(timeoutObj)
        resolve(this)
      })
    })
  }

  stop () {
    return new Promise((resolve) => {
      this.server.on('close', resolve)
      this.server.close()
    })
  }

  /**
   * Remove any existing config added by calls to FakeAgent#addRemoteConfig.
   */
  resetRemoteConfig () {
    this._rc_files = []
  }

  /**
   * Add a config object to be returned by the fake Remote Config endpoint.
   * @param {Object} config - Object containing the Remote Config "file" and metadata
   * @param {number} [config.orgId=2] - The Datadog organization ID
   * @param {string} config.product - The Remote Config product name
   * @param {string} config.id - The Remote Config config ID
   * @param {string} [config.name] - The Remote Config "name". Defaults to the sha256 hash of `config.id`
   * @param {Object} config.config - The Remote Config "file" object
   */
  addRemoteConfig (config) {
    config = { ...config }
    config.orgId = config.orgId || 2
    config.name = config.name || createHash('sha256').update(config.id).digest('hex')
    config.config = JSON.stringify(config.config)

    this._rc_files.push(config)
  }

  // **resolveAtFirstSuccess** - specific use case for Next.js (or any other future libraries)
  // where multiple payloads are generated, and only one is expected to have the proper span (ie next.request),
  // but it't not guaranteed to be the last one (so, expectedMessageCount would not be helpful).
  // It can still fail if it takes longer than `timeout` duration or if none pass the assertions (timeout still called)
  assertMessageReceived (fn, timeout, expectedMessageCount = 1, resolveAtFirstSuccess) {
    timeout = timeout || 30000
    let resultResolve
    let resultReject
    let msgCount = 0
    const errors = []

    const timeoutObj = setTimeout(() => {
      const errorsMsg = errors.length === 0 ? '' : `, additionally:\n${errors.map(e => e.stack).join('\n')}\n===\n`
      resultReject(new Error(`timeout${errorsMsg}`, { cause: { errors } }))
    }, timeout)

    const resultPromise = new Promise((resolve, reject) => {
      resultResolve = () => {
        clearTimeout(timeoutObj)
        resolve()
      }
      resultReject = (e) => {
        clearTimeout(timeoutObj)
        reject(e)
      }
    })

    const messageHandler = msg => {
      try {
        msgCount += 1
        fn(msg)
        if (resolveAtFirstSuccess || msgCount === expectedMessageCount) {
          resultResolve()
          this.removeListener('message', messageHandler)
        }
      } catch (e) {
        errors.push(e)
      }
    }
    this.on('message', messageHandler)

    return resultPromise
  }

  assertTelemetryReceived (fn, timeout, requestType, expectedMessageCount = 1) {
    timeout = timeout || 30000
    let resultResolve
    let resultReject
    let msgCount = 0
    const errors = []

    const timeoutObj = setTimeout(() => {
      const errorsMsg = errors.length === 0 ? '' : `, additionally:\n${errors.map(e => e.stack).join('\n')}\n===\n`
      resultReject(new Error(`timeout${errorsMsg}`, { cause: { errors } }))
    }, timeout)

    const resultPromise = new Promise((resolve, reject) => {
      resultResolve = () => {
        clearTimeout(timeoutObj)
        resolve()
      }
      resultReject = (e) => {
        clearTimeout(timeoutObj)
        reject(e)
      }
    })

    const messageHandler = msg => {
      if (msg.payload.request_type !== requestType) return
      msgCount += 1
      try {
        fn(msg)
        if (msgCount === expectedMessageCount) {
          resultResolve()
        }
      } catch (e) {
        errors.push(e)
      }
      if (msgCount === expectedMessageCount) {
        this.removeListener('telemetry', messageHandler)
      }
    }
    this.on('telemetry', messageHandler)

    return resultPromise
  }
}

function buildExpressServer (agent) {
  const app = express()

  app.use(bodyParser.raw({ limit: Infinity, type: 'application/msgpack' }))
  app.use(bodyParser.json({ limit: Infinity, type: 'application/json' }))

  app.put('/v0.4/traces', (req, res) => {
    if (req.body.length === 0) return res.status(200).send()
    res.status(200).send({ rate_by_service: { 'service:,env:': 1 } })
    agent.emit('message', {
      headers: req.headers,
      payload: msgpack.decode(req.body, { codec })
    })
  })

  app.post('/v0.7/config', (req, res) => {
    const {
      client: { products, state },
      cached_target_files: cachedTargetFiles
    } = req.body

    if (state.has_error) {
      // Print the error sent by the client in case it's useful in debugging tests
      console.error(state.error) // eslint-disable-line no-console
    }

    for (const { apply_error: error } of state.config_states) {
      if (error) {
        // Print the error sent by the client in case it's useful in debugging tests
        console.error(error) // eslint-disable-line no-console
      }
    }

    // The actual targets object is much more complicated,
    // but the Node.js tracer currently only cares about the following properties.
    const targets = {
      signed: {
        custom: { opaque_backend_state: 'foo' },
        targets: {},
        version: 12345
      }
    }
    const targetFiles = []
    const clientConfigs = []

    const files = agent._rc_files.filter(({ product }) => products.includes(product))

    for (const { orgId, product, id, name, config } of files) {
      const path = `datadog/${orgId}/${product}/${id}/${name}`
      const fileDigest = createHash('sha256').update(config).digest('hex')

      if (cachedTargetFiles.some((cached) =>
        path === cached.path &&
        fileDigest === cached.hashes.find((e) => e.algorithm === 'sha256').hash
      )) {
        continue // skip files already cached by the client so we don't send them more than once
      }

      targets.signed.targets[path] = {
        custom: { v: 20 },
        hashes: { sha256: fileDigest },
        length: config.length
      }

      targetFiles.push({ path, raw: base64(config) })
      clientConfigs.push(path)
    }

    // The real response object also contains a `roots` property which has been omitted here since it's not currently
    // used by the Node.js tracer.
    res.json(
      clientConfigs.length === 0
        ? {}
        : {
            targets: targets.signed.targets.length === 0 ? '' : base64(targets),
            target_files: targetFiles,
            client_configs: clientConfigs
          }
    )
  })

  app.post('/profiling/v1/input', upload.any(), (req, res) => {
    res.status(200).send()
    agent.emit('message', {
      headers: req.headers,
      payload: req.body,
      files: req.files
    })
  })

  app.post('/telemetry/proxy/api/v2/apmtelemetry', (req, res) => {
    res.status(200).send()
    agent.emit('telemetry', {
      headers: req.headers,
      payload: req.body
    })
  })

  return app
}

function base64 (strOrObj) {
  const str = typeof strOrObj === 'string' ? strOrObj : JSON.stringify(strOrObj)
  return Buffer.from(str).toString('base64')
}
