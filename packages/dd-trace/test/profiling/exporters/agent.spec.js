'use strict'

require('../../setup/tap')

const tracer = require('../../../../../init')
const expect = require('chai').expect
const sinon = require('sinon')
const express = require('express')
const upload = require('multer')()
const os = require('os')
const path = require('path')
const { request } = require('http')
const proxyquire = require('proxyquire')
const WallProfiler = require('../../../src/profiling/profilers/wall')
const SpaceProfiler = require('../../../src/profiling/profilers/space')
const logger = require('../../../src/log')
const { Profile } = require('pprof-format')
const version = require('../../../../../package.json').version

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
      }
    }
  })

  await wait(50)

  const profile = profiler.profile(false)
  return profiler.encode(profile)
}

const describeOnUnix = os.platform() === 'win32' ? describe.skip : describe

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
    expect(req.headers).to.have.property('test', 'injected')
    expect(req.headers).to.have.property('dd-evp-origin', 'dd-trace-js')
    expect(req.headers).to.have.property('dd-evp-origin-version', version)

    expect(req.files[0]).to.have.property('fieldname', 'event')
    expect(req.files[0]).to.have.property('originalname', 'event.json')
    expect(req.files[0]).to.have.property('mimetype', 'application/json')
    expect(req.files[0]).to.have.property('size', req.files[0].buffer.length)

    const event = JSON.parse(req.files[0].buffer.toString())
    expect(event).to.have.property('attachments')
    expect(event.attachments).to.have.lengthOf(2)
    expect(event.attachments[0]).to.equal('wall.pprof')
    expect(event.attachments[1]).to.equal('space.pprof')
    expect(event).to.have.property('start', start.toISOString())
    expect(event).to.have.property('end', end.toISOString())
    expect(event).to.have.property('family', 'node')
    expect(event).to.have.property('version', '4')
    expect(event).to.have.property('tags_profiler', [
      'language:javascript',
      'runtime:nodejs',
      `runtime_arch:${process.arch}`,
      `runtime_os:${process.platform}`,
      `runtime_version:${process.version}`,
      `process_id:${process.pid}`,
      `profiler_version:${version}`,
      'format:pprof',
      `runtime-id:${RUNTIME_ID}`
    ].join(','))
    expect(event).to.have.property('info')
    expect(event.info).to.have.property('application')
    expect(Object.keys(event.info.application)).to.have.length(4)
    expect(event.info.application).to.have.property('env', ENV)
    expect(event.info.application).to.have.property('service', SERVICE)
    expect(event.info.application).to.have.property('start_time')
    expect(event.info.application).to.have.property('version', '1.2.3')
    expect(event.info).to.have.property('platform')
    expect(Object.keys(event.info.platform)).to.have.length(4)
    expect(event.info.platform).to.have.property('hostname', HOST)
    expect(event.info.platform).to.have.property('kernel_name', os.type())
    expect(event.info.platform).to.have.property('kernel_release', os.release())
    expect(event.info.platform).to.have.property('kernel_version', os.version())
    expect(event.info).to.have.property('profiler')
    expect(Object.keys(event.info.profiler)).to.have.length(3)
    expect(event.info.profiler).to.have.property('activation', 'unknown')
    expect(event.info.profiler).to.have.property('ssi')
    expect(event.info.profiler.ssi).to.have.property('mechanism', 'none')
    expect(event.info.profiler).to.have.property('version', version)
    expect(event.info).to.have.property('runtime')
    expect(Object.keys(event.info.runtime)).to.have.length(3)
    expect(event.info.runtime).to.have.property('available_processors')
    expect(event.info.runtime).to.have.property('engine', 'nodejs')
    expect(event.info.runtime).to.have.property('version', process.version.substring(1))

    expect(req.files[1]).to.have.property('fieldname', 'wall.pprof')
    expect(req.files[1]).to.have.property('originalname', 'wall.pprof')
    expect(req.files[1]).to.have.property('mimetype', 'application/octet-stream')
    expect(req.files[1]).to.have.property('size', req.files[1].buffer.length)

    expect(req.files[2]).to.have.property('fieldname', 'space.pprof')
    expect(req.files[2]).to.have.property('originalname', 'space.pprof')
    expect(req.files[2]).to.have.property('mimetype', 'application/octet-stream')
    expect(req.files[2]).to.have.property('size', req.files[2].buffer.length)

    const wallProfile = Profile.decode(req.files[1].buffer)
    const spaceProfile = Profile.decode(req.files[2].buffer)

    expect(wallProfile).to.be.a.profile
    expect(spaceProfile).to.be.a.profile

    expect(wallProfile).to.deep.equal(Profile.decode(profiles.wall))
    expect(spaceProfile).to.deep.equal(Profile.decode(profiles.space))
  }

  beforeEach(() => {
    docker = {
      inject (carrier) {
        carrier.test = 'injected'
      }
    }
    http = {
      request: sinon.spy(request)
    }
    const agent = proxyquire('../../../src/profiling/exporters/agent', {
      '../../exporters/common/docker': docker,
      http
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
      host: HOST
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
        'runtime-id': RUNTIME_ID
      }

      const [wall, space] = await Promise.all([
        createProfile(['wall', 'microseconds']),
        createProfile(['space', 'bytes'])
      ])

      const profiles = {
        wall,
        space
      }

      await new Promise((resolve, reject) => {
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
      })

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
        'runtime-id': RUNTIME_ID
      }

      const [wall, space] = await Promise.all([
        createProfile(['wall', 'microseconds']),
        createProfile(['space', 'bytes'])
      ])

      const profiles = {
        wall,
        space
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
        expect(err.message).to.match(/^HTTP Error 500$/)
        failed = true
      }
      expect(failed).to.be.true
      expect(attempt).to.be.greaterThan(0)

      // Verify computeRetries produces correct starting values
      for (let i = 1; i <= 100; i++) {
        const [retries, timeout] = computeRetries(i * 1000)
        expect(retries).to.be.gte(2)
        expect(timeout).to.be.lte(1000)
        expect(Number.isInteger(timeout)).to.be.true
      }

      const initialTimeout = computeRetries(uploadTimeout)[1]
      const spyCalls = http.request.getCalls()
      for (let i = 0; i < spyCalls.length; i++) {
        const call = spyCalls[i]

        // Verify number does not have decimals as this causes timer warnings
        expect(Number.isInteger(call.args[0].timeout)).to.be.true

        // Retry is 1-indexed so add 1 to i
        expect(call.args[0].timeout)
          .to.equal(initialTimeout * Math.pow(2, i + 1))
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
        /^Agent export response: ([0-9a-f]{2}( |$))*/
      ]

      let doneLogs
      const waitForResponse = new Promise((resolve) => {
        doneLogs = resolve
      })

      function onMessage (message) {
        const expected = expectedLogs[index++]
        expect(typeof message === 'function' ? message() : message)
          .to.match(expected)
        if (index >= expectedLogs.length) doneLogs()
      }

      let index = 0
      const exporter = newAgentExporter({ url, logger: { debug: onMessage, warn: onMessage } })
      const start = new Date()
      const end = new Date()
      const tags = { foo: 'bar' }

      const [wall, space] = await Promise.all([
        createProfile(['wall', 'microseconds']),
        createProfile(['space', 'bytes'])
      ])

      const profiles = {
        wall,
        space
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
          'content-length': data.length
        })
        res.end(data)
      })

      await Promise.all([
        exporter.export({ profiles, start, end, tags }),
        waitForResponse
      ])
    })

    it('should not retry on 4xx errors', async function () {
      const exporter = newAgentExporter({ url, logger: { debug: () => {}, warn: () => {} } })
      const start = new Date()
      const end = new Date()
      const tags = { foo: 'bar' }

      const [wall, space] = await Promise.all([
        createProfile(['wall', 'microseconds']),
        createProfile(['space', 'bytes'])
      ])

      const profiles = {
        wall,
        space
      }

      let tries = 0
      const json = JSON.stringify({ error: 'some error' })
      app.post('/profiling/v1/input', upload.any(), (_, res) => {
        tries++
        const data = Buffer.from(json)
        res.writeHead(400, {
          'content-type': 'application/json',
          'content-length': data.length
        })
        res.end(data)
      })

      try {
        await exporter.export({ profiles, start, end, tags })
        throw new Error('should have thrown')
      } catch (err) {
        expect(err.message).to.equal('HTTP Error 400')
      }
      expect(tries).to.equal(1)
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
        'runtime-id': RUNTIME_ID
      }

      const [wall, space] = await Promise.all([
        createProfile(['wall', 'microseconds']),
        createProfile(['space', 'bytes'])
      ])

      const profiles = {
        wall,
        space
      }

      await new Promise((resolve, reject) => {
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
      })
    })
  })

  describeOnUnix('using UDS', () => {
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
        'runtime-id': RUNTIME_ID
      }

      const [wall, space] = await Promise.all([
        createProfile(['wall', 'microseconds']),
        createProfile(['space', 'bytes'])
      ])

      const profiles = {
        wall,
        space
      }

      await new Promise((resolve, reject) => {
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
      })
    })
  })
})
