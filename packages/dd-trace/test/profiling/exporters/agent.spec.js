'use strict'

const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')
const { request } = require('node:http')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')
const express = require('express')
const upload = require('multer')()

const { Profile } = require('../../../../../vendor/dist/pprof-format')
require('../../setup/core')
const tracer = require('../../../../../init')
const WallProfiler = require('../../../src/profiling/profilers/wall')
const SpaceProfiler = require('../../../src/profiling/profilers/space')
const logger = require('../../../src/log')
const { assertObjectContains } = require('../../../../../integration-tests/helpers')
const version = require('../../../../../package.json').version
const processTags = require('../../../src/process-tags')

const RUNTIME_ID = 'a1b2c3d4-a1b2-a1b2-a1b2-a1b2c3d4e5f6'
const ENV = 'test-env'
const HOST = 'test-host'
const SERVICE = 'test-service'
const APP_VERSION = '1.2.3'

function wait (ms) {
  return new Promise((resolve, reject) => {
    setTimeout(resolve, ms)
  })
}

async function createProfile (periodType) {
  const [type] = periodType
  const profiler = type === 'wall' ? new WallProfiler() : new SpaceProfiler()
  profiler.start({
    // Throw errors in test rather than logging them
    logger: {
      error (err) {
        throw err
      },
      warn (err) {
      },
    },
  })

  await wait(50)

  const profile = profiler.profile(false)
  return profiler.encode(profile)
}

describe('exporters/agent', function () {
  let AgentExporter
  let sockets
  let url
  let listener
  let app
  let docker
  let http
  let computeRetries
  let startSpan

  function verifyRequest (req, profiles, start, end) {
    assert.strictEqual(req.headers.test, 'injected')
    assert.strictEqual(req.headers['dd-evp-origin'], 'dd-trace-js')
    assert.strictEqual(req.headers['dd-evp-origin-version'], version)

    assert.strictEqual(req.files[0].fieldname, 'event')
    assert.strictEqual(req.files[0].originalname, 'event.json')
    assert.strictEqual(req.files[0].mimetype, 'application/json')
    assert.strictEqual(req.files[0].size, req.files[0].buffer.length)

    const event = JSON.parse(req.files[0].buffer.toString())

    assert.strictEqual(typeof event.info.application.start_time, 'string')

    delete event.info.application.start_time

    assert.deepStrictEqual(event, {
      attachments: ['wall.pprof', 'space.pprof'],
      start: start.toISOString(),
      end: end.toISOString(),
      family: 'node',
      version: '4',
      tags_profiler: [
        'language:javascript',
        'runtime:nodejs',
        `runtime_arch:${process.arch}`,
        `runtime_os:${process.platform}`,
        `runtime_version:${process.version}`,
        `process_id:${process.pid}`,
        `profiler_version:${version}`,
        'format:pprof',
        `runtime-id:${RUNTIME_ID}`,
      ].join(','),
      info: {
        application: {
          env: ENV,
          service: SERVICE,
          version: APP_VERSION,
        },
        platform: {
          hostname: HOST,
          kernel_name: os.type(),
          kernel_release: os.release(),
          kernel_version: os.version(),
        },
        profiler: {
          activation: 'unknown',
          ssi: {
            mechanism: 'none',
          },
          version,
        },
        runtime: {
          // @ts-expect-error - availableParallelism is only available from node 18.14.0 and above
          available_processors: os.availableParallelis?.() ?? os.cpus().length,
          engine: 'nodejs',
          version: process.version.substring(1),
        },
      },
      process_tags: processTags.serialized,
    })

    assertObjectContains(req.files, [{
      fieldname: 'wall.pprof',
      originalname: 'wall.pprof',
      mimetype: 'application/octet-stream',
      size: req.files[1].buffer.length,
    }, {
      fieldname: 'space.pprof',
      originalname: 'space.pprof',
      mimetype: 'application/octet-stream',
      size: req.files[2].buffer.length,
    }])

    const wallProfile = Profile.decode(req.files[1].buffer)
    const spaceProfile = Profile.decode(req.files[2].buffer)

    assertIsProfile(wallProfile)
    assertIsProfile(spaceProfile)

    assert.deepStrictEqual(wallProfile, Profile.decode(profiles.wall))
    assert.deepStrictEqual(spaceProfile, Profile.decode(profiles.space))
  }

  beforeEach(() => {
    docker = {
      inject (carrier) {
        carrier.test = 'injected'
      },
    }
    http = {
      request: sinon.spy(request),
    }
    const agent = proxyquire('../../../src/profiling/exporters/agent', {
      '../../exporters/common/docker': docker,
      http,
    })
    AgentExporter = agent.AgentExporter
    computeRetries = agent.computeRetries
    sockets = []
    app = express()
  })

  function newAgentExporter ({ url, logger, uploadTimeout = 100 }) {
    return new AgentExporter({
      url,
      logger,
      uploadTimeout,
      env: ENV,
      service: SERVICE,
      version: APP_VERSION,
      host: HOST,
    })
  }

  describe('using HTTP', () => {
    beforeEach(done => {
      listener = app.listen(0, '127.0.0.1', () => {
        const port = listener.address().port
        url = new URL(`http://127.0.0.1:${port}`)
        done()
      })
      listener.on('connection', socket => sockets.push(socket))
      startSpan = sinon.spy(tracer._tracer, 'startSpan')
    })

    afterEach(done => {
      listener.close(done)
      sockets.forEach(socket => socket.end())
      tracer._tracer.startSpan.restore()
    })

    it('should send profiles as pprof to the intake', async () => {
      const exporter = newAgentExporter({ url, logger })
      const start = new Date()
      const end = new Date()
      const tags = {
        'runtime-id': RUNTIME_ID,
      }

      const [wall, space] = await Promise.all([
        createProfile(['wall', 'microseconds']),
        createProfile(['space', 'bytes']),
      ])

      const profiles = {
        wall,
        space,
      }

      await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
        app.post('/profiling/v1/input', upload.any(), (req, res) => {
          try {
            verifyRequest(req, profiles, start, end)
            resolve()
          } catch (e) {
            reject(e)
          }

          res.send()
        })

        exporter.export({ profiles, start, end, tags }).catch(reject)
      }))

      startSpan.getCalls().forEach(call => {
        const [name, { tags }] = call.args
        if (name === 'http.request' && tags && tags['http.url'] && tags['http.url'].endsWith('/profiling/v1/input')) {
          throw new Error('traced profiling endpoint call')
        }
      })
    })

    it('should backoff up to the uploadTimeout', async () => {
      const uploadTimeout = 100
      const exporter = newAgentExporter({ url, logger, uploadTimeout })

      const start = new Date()
      const end = new Date()
      const tags = {
        'runtime-id': RUNTIME_ID,
      }

      const [wall, space] = await Promise.all([
        createProfile(['wall', 'microseconds']),
        createProfile(['space', 'bytes']),
      ])

      const profiles = {
        wall,
        space,
      }

      let attempt = 0
      app.post('/profiling/v1/input', upload.any(), (req, res) => {
        attempt++
        verifyRequest(req, profiles, start, end)
        if (attempt % 2) {
          res.writeHead(500)
          res.end()
        } else {
          res.destroy()
        }
      })

      let failed = false
      try {
        await exporter.export({ profiles, start, end, tags })
      } catch (err) {
        assert.match(err.message, /^HTTP Error 500$/)
        failed = true
      }
      assert.strictEqual(failed, true)
      assert.ok(attempt > 0)

      // Verify computeRetries produces correct starting values
      for (let i = 1; i <= 100; i++) {
        const [retries, timeout] = computeRetries(i * 1000)
        assert.ok(retries >= 2)
        assert.ok(timeout <= 1000)
        assert.strictEqual(Number.isInteger(timeout), true)
      }

      const initialTimeout = computeRetries(uploadTimeout)[1]
      const spyCalls = http.request.getCalls()
      for (let i = 0; i < spyCalls.length; i++) {
        const call = spyCalls[i]

        // Verify number does not have decimals as this causes timer warnings
        assert.strictEqual(Number.isInteger(call.args[0].timeout), true)

        // Retry is 1-indexed so add 1 to i
        assert.strictEqual(call.args[0].timeout, initialTimeout * Math.pow(2, i + 1))
      }
    })

    it('should log exports and handle http errors gracefully', async function () {
      const expectedLogs = [
        /^Building agent export report:\n\{.+\}$/,
        /^Adding wall profile to agent export:( [0-9a-f]{2})+$/,
        /^Adding space profile to agent export:( [0-9a-f]{2})+$/,
        /^Submitting profiler agent report attempt #1 to:/i,
        /^Error from the agent: HTTP Error 500$/,
        /^Submitting profiler agent report attempt #2 to:/i,
        /^Agent export response: ([0-9a-f]{2}( |$))*/,
      ]

      let doneLogs
      const waitForResponse = new Promise((resolve) => {
        doneLogs = resolve
      })

      function onMessage (message) {
        const expected = expectedLogs[index++]
        assert.match(typeof message === 'function' ? message() : message, expected)
        if (index >= expectedLogs.length) doneLogs()
      }

      let index = 0
      const exporter = newAgentExporter({ url, logger: { debug: onMessage, warn: onMessage } })
      const start = new Date()
      const end = new Date()
      const tags = { foo: 'bar' }

      const [wall, space] = await Promise.all([
        createProfile(['wall', 'microseconds']),
        createProfile(['space', 'bytes']),
      ])

      const profiles = {
        wall,
        space,
      }

      let tries = 0
      const json = JSON.stringify({ error: 'some error' })
      app.post('/profiling/v1/input', upload.any(), (req, res) => {
        if (++tries > 1) {
          res.end()
          return
        }
        const data = Buffer.from(json)
        res.writeHead(500, {
          'content-type': 'application/json',
          'content-length': data.length,
        })
        res.end(data)
      })

      await Promise.all([
        exporter.export({ profiles, start, end, tags }),
        waitForResponse,
      ])
    })

    it('should not retry on 4xx errors', async function () {
      const exporter = newAgentExporter({ url, logger: { debug: () => {}, warn: () => {} } })
      const start = new Date()
      const end = new Date()
      const tags = { foo: 'bar' }

      const [wall, space] = await Promise.all([
        createProfile(['wall', 'microseconds']),
        createProfile(['space', 'bytes']),
      ])

      const profiles = {
        wall,
        space,
      }

      let tries = 0
      const json = JSON.stringify({ error: 'some error' })
      app.post('/profiling/v1/input', upload.any(), (_, res) => {
        tries++
        const data = Buffer.from(json)
        res.writeHead(400, {
          'content-type': 'application/json',
          'content-length': data.length,
        })
        res.end(data)
      })

      try {
        await exporter.export({ profiles, start, end, tags })
        throw new Error('should have thrown')
      } catch (err) {
        assert.strictEqual(err.message, 'HTTP Error 400')
      }
      assert.strictEqual(tries, 1)
    })
  })

  describe('using ipv6', () => {
    beforeEach(done => {
      listener = app.listen(0, '0:0:0:0:0:0:0:1', () => {
        const port = listener.address().port
        url = new URL(`http://[0:0:0:0:0:0:0:1]:${port}`)
        done()
      })
      listener.on('connection', socket => sockets.push(socket))
      startSpan = sinon.spy(tracer._tracer, 'startSpan')
    })

    afterEach(done => {
      listener.close(done)
      sockets.forEach(socket => socket.end())
      tracer._tracer.startSpan.restore()
    })

    it('should support ipv6 urls', async () => {
      const exporter = newAgentExporter({ url, logger })
      const start = new Date()
      const end = new Date()
      const tags = {
        'runtime-id': RUNTIME_ID,
      }

      const [wall, space] = await Promise.all([
        createProfile(['wall', 'microseconds']),
        createProfile(['space', 'bytes']),
      ])

      const profiles = {
        wall,
        space,
      }

      await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
        app.post('/profiling/v1/input', upload.any(), (req, res) => {
          try {
            verifyRequest(req, profiles, start, end)
            resolve()
          } catch (e) {
            reject(e)
          }

          res.send()
        })

        exporter.export({ profiles, start, end, tags }).catch(reject)
      }))
    })
  })

  ;(os.platform() === 'win32' ? describe.skip : describe)('using UDS', () => {
    let listener

    beforeEach(done => {
      url = `${path.join(os.tmpdir(), `dd-trace-profiler-test-${Date.now()}`)}.sock`

      listener = app.listen(url, done)
      listener.on('connection', socket => sockets.push(socket))
    })

    afterEach(done => {
      listener.close(done)
      sockets.forEach(socket => socket.end())
    })

    it('should support Unix domain sockets', async () => {
      const exporter = newAgentExporter({ url: new URL(`unix://${url}`), logger })
      const start = new Date()
      const end = new Date()
      const tags = {
        'runtime-id': RUNTIME_ID,
      }

      const [wall, space] = await Promise.all([
        createProfile(['wall', 'microseconds']),
        createProfile(['space', 'bytes']),
      ])

      const profiles = {
        wall,
        space,
      }

      await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
        app.post('/profiling/v1/input', upload.any(), (req, res) => {
          try {
            verifyRequest(req, profiles, start, end)
            resolve()
          } catch (e) {
            reject(e)
          }

          res.send()
        })

        exporter.export({ profiles, start, end, tags }).catch(reject)
      }))
    })
  })
})

function assertIsProfile (obj, msg) {
  assert.ok(typeof obj === 'object' && obj !== null, msg)
  assert.strictEqual(typeof obj.timeNanos, 'bigint', msg)
  assert.ok(typeof obj.period === 'number' || typeof obj.period === 'bigint', msg)

  assertIsValueType(obj.periodType, msg)

  assert.ok(Array.isArray(obj.sampleType), msg)
  assert.strictEqual(obj.sampleType.length, 2, msg)
  assert.ok(Array.isArray(obj.sample), msg)
  assert.ok(Array.isArray(obj.location), msg)
  assert.ok(Array.isArray(obj.function), msg)

  assert.ok(typeof obj.stringTable === 'object' && obj.stringTable !== null, msg)
  assert.ok(Array.isArray(obj.stringTable.strings), msg)
  assert.ok(obj.stringTable.strings.length >= 1, msg)
  assert.strictEqual(obj.stringTable.strings[0], '', msg)

  for (const sampleType of obj.sampleType) {
    assertIsValueType(sampleType, msg)
  }

  for (const fn of obj.function) {
    assert.strictEqual(typeof fn.filename, 'number', msg)
    assert.strictEqual(typeof fn.systemName, 'number', msg)
    assert.strictEqual(typeof fn.name, 'number', msg)
    assert.ok(Number.isSafeInteger(fn.id), msg)
  }

  for (const location of obj.location) {
    assert.ok(Number.isSafeInteger(location.id), msg)
    assert.ok(Array.isArray(location.line), msg)

    for (const line of location.line) {
      assert.ok(Number.isSafeInteger(line.functionId), msg)
      assert.strictEqual(typeof line.line, 'number', msg)
    }
  }

  for (const sample of obj.sample) {
    assert.ok(Array.isArray(sample.locationId), msg)
    assert.ok(sample.locationId.length >= 1, msg)
    assert.ok(Array.isArray(sample.value), msg)
    assert.strictEqual(sample.value.length, obj.sampleType.length, msg)
  }

  function assertIsValueType (valueType, msg) {
    assert.ok(typeof valueType === 'object' && valueType !== null, msg)
    assert.strictEqual(typeof valueType.type, 'number', msg)
    assert.strictEqual(typeof valueType.unit, 'number', msg)
  }
}
