'use strict'

const expect = require('chai').expect
const sinon = require('sinon')
const express = require('express')
const upload = require('multer')()
const os = require('os')
const path = require('path')
const { request } = require('http')
const getPort = require('get-port')
const proxyquire = require('proxyquire')
const { gunzipSync } = require('zlib')
const WallProfiler = require('../../../src/profiling/profilers/wall')
const SpaceProfiler = require('../../../src/profiling/profilers/space')
const logger = require('../../../src/log')
const { Profile } = require('pprof-format')
const semver = require('semver')
const version = require('../../../../../package.json').version

if (!semver.satisfies(process.version, '>=10.12')) {
  describe = describe.skip // eslint-disable-line no-global-assign
}

function wait (ms) {
  return new Promise((resolve, reject) => {
    setTimeout(resolve, ms)
  })
}

async function createProfile (periodType) {
  const [ type ] = periodType
  const profiler = type === 'wall' ? new WallProfiler() : new SpaceProfiler()
  profiler.start({
    // Throw errors in test rather than logging them
    logger: {
      error (err) {
        throw err
      }
    }
  })

  await wait(50)

  const profile = profiler.profile()
  profiler.stop()
  return profiler.encode(profile)
}

const describeOnUnix = os.platform() === 'win32' ? describe.skip : describe

describe('exporters/agent', function () {
  this.timeout(10000)

  let AgentExporter
  let sockets
  let url
  let listener
  let app
  let docker
  let http
  let computeRetries

  function verifyRequest (req, profiles, start, end) {
    expect(req.headers).to.have.property('datadog-container-id', docker.id())
    expect(req.body).to.have.property('language', 'javascript')
    expect(req.body).to.have.property('runtime', 'nodejs')
    expect(req.body).to.have.property('runtime_version', process.version)
    expect(req.body).to.have.property('profiler_version', version)
    expect(req.body).to.have.property('format', 'pprof')
    expect(req.body).to.have.deep.property('tags', [
      'language:javascript',
      'runtime:nodejs',
      `runtime_version:${process.version}`,
      `profiler_version:${version}`,
      'format:pprof',
      'runtime-id:a1b2c3d4-a1b2-a1b2-a1b2-a1b2c3d4e5f6'
    ])
    expect(req.body).to.have.deep.property('types', ['wall', 'space'])
    expect(req.body).to.have.property('recording-start', start.toISOString())
    expect(req.body).to.have.property('recording-end', end.toISOString())

    expect(req.files[0]).to.have.property('fieldname', 'data[0]')
    expect(req.files[0]).to.have.property('originalname', 'wall.pb.gz')
    expect(req.files[0]).to.have.property('mimetype', 'application/octet-stream')
    expect(req.files[0]).to.have.property('size', req.files[0].buffer.length)

    expect(req.files[1]).to.have.property('fieldname', 'data[1]')
    expect(req.files[1]).to.have.property('originalname', 'space.pb.gz')
    expect(req.files[1]).to.have.property('mimetype', 'application/octet-stream')
    expect(req.files[1]).to.have.property('size', req.files[1].buffer.length)

    const wallProfile = Profile.decode(gunzipSync(req.files[0].buffer))
    const spaceProfile = Profile.decode(gunzipSync(req.files[1].buffer))

    expect(wallProfile).to.be.a.profile
    expect(spaceProfile).to.be.a.profile

    expect(wallProfile).to.deep.equal(Profile.decode(gunzipSync(profiles.wall)))
    expect(spaceProfile).to.deep.equal(Profile.decode(gunzipSync(profiles.space)))
  }

  beforeEach(() => {
    docker = {
      id () {
        return 'container-id'
      }
    }
    http = {
      request: sinon.spy(request)
    }
    const agent = proxyquire('../../../src/profiling/exporters/agent', {
      '../../exporters/common/docker': docker,
      'http': http
    })
    AgentExporter = agent.AgentExporter
    computeRetries = agent.computeRetries
    sockets = []
    app = express()
  })

  describe('using HTTP', () => {
    beforeEach(done => {
      getPort().then(port => {
        url = new URL(`http://127.0.0.1:${port}`)

        listener = app.listen(port, '127.0.0.1', done)
        listener.on('connection', socket => sockets.push(socket))
      })
    })

    afterEach(done => {
      listener.close(done)
      sockets.forEach(socket => socket.end())
    })

    it('should send profiles as pprof to the intake', async () => {
      const exporter = new AgentExporter({ url, logger, uploadTimeout: 100 })
      const start = new Date()
      const end = new Date()
      const tags = {
        'runtime-id': 'a1b2c3d4-a1b2-a1b2-a1b2-a1b2c3d4e5f6'
      }

      const [ wall, space ] = await Promise.all([
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

    it('should backoff up to the uploadTimeout', async () => {
      const uploadTimeout = 100
      const exporter = new AgentExporter({
        url,
        logger,
        uploadTimeout
      })

      const start = new Date()
      const end = new Date()
      const tags = {
        'runtime-id': 'a1b2c3d4-a1b2-a1b2-a1b2-a1b2c3d4e5f6'
      }

      const [ wall, space ] = await Promise.all([
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
        expect(err.message).to.match(/^Profiler agent export back-off period expired$/)
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
      this.timeout(10000)
      const expectedLogs = [
        /^Building agent export report: (\n {2}[a-z-_]+(\[\])?: [a-z0-9-TZ:.]+)+$/m,
        /^Adding wall profile to agent export:( [0-9a-f]{2})+$/,
        /^Adding space profile to agent export:( [0-9a-f]{2})+$/,
        /^Submitting profiler agent report attempt #1 to:/i,
        /^Error from the agent: HTTP Error 400$/,
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
      const exporter = new AgentExporter({
        url,
        uploadTimeout: 100,
        logger: {
          debug: onMessage,
          error: onMessage
        }
      })
      const start = new Date()
      const end = new Date()
      const tags = { foo: 'bar' }

      const [ wall, space ] = await Promise.all([
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
        res.writeHead(400, {
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
      const exporter = new AgentExporter({ url: new URL(`unix://${url}`), logger, uploadTimeout: 100 })
      const start = new Date()
      const end = new Date()
      const tags = { foo: 'bar' }

      const [ wall, space ] = await Promise.all([
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
            expect(req.body).to.have.property('language', 'javascript')
            expect(req.body).to.have.property('runtime', 'nodejs')
            expect(req.body).to.have.property('runtime_version', process.version)
            expect(req.body).to.have.property('profiler_version', version)
            expect(req.body).to.have.property('format', 'pprof')
            expect(req.body).to.have.deep.property('tags', [
              'language:javascript',
              'runtime:nodejs',
              `runtime_version:${process.version}`,
              `profiler_version:${version}`,
              'format:pprof',
              'foo:bar'
            ])
            expect(req.body).to.have.deep.property('types', ['wall', 'space'])
            expect(req.body).to.have.property('recording-start', start.toISOString())
            expect(req.body).to.have.property('recording-end', end.toISOString())

            expect(req.files[0]).to.have.property('fieldname', 'data[0]')
            expect(req.files[0]).to.have.property('originalname', 'wall.pb.gz')
            expect(req.files[0]).to.have.property('mimetype', 'application/octet-stream')
            expect(req.files[0]).to.have.property('size', req.files[0].buffer.length)

            expect(req.files[1]).to.have.property('fieldname', 'data[1]')
            expect(req.files[1]).to.have.property('originalname', 'space.pb.gz')
            expect(req.files[1]).to.have.property('mimetype', 'application/octet-stream')
            expect(req.files[1]).to.have.property('size', req.files[1].buffer.length)

            const wallProfile = Profile.decode(gunzipSync(req.files[0].buffer))
            const spaceProfile = Profile.decode(gunzipSync(req.files[1].buffer))

            expect(wallProfile).to.be.a.profile
            expect(spaceProfile).to.be.a.profile

            expect(wallProfile).to.deep.equal(Profile.decode(gunzipSync(profiles.wall)))
            expect(spaceProfile).to.deep.equal(Profile.decode(gunzipSync(profiles.space)))

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
