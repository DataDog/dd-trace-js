'use strict'

const expect = require('chai').expect
const express = require('express')
const upload = require('multer')()
const os = require('os')
const path = require('path')
const getPort = require('get-port')
const { gunzipSync } = require('zlib')
const CpuProfiler = require('../../../src/profiling/profilers/cpu')
const HeapProfiler = require('../../../src/profiling/profilers/heap')
const logger = require('../../../src/log')
const { perftools } = require('@datadog/pprof/proto/profile')
const semver = require('semver')

if (!semver.satisfies(process.version, '>=10.12')) {
  describe = describe.skip // eslint-disable-line no-global-assign
}

const { decode } = perftools.profiles.Profile

function wait (ms) {
  return new Promise((resolve, reject) => {
    setTimeout(resolve, ms)
  })
}

async function createProfile (periodType) {
  const [ type ] = periodType
  const profiler = type === 'wall' ? new CpuProfiler() : new HeapProfiler()
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

describe('exporters/agent', () => {
  let AgentExporter
  let sockets
  let url
  let listener
  let app

  beforeEach(() => {
    AgentExporter = require('../../../src/profiling/exporters/agent').AgentExporter
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
      const exporter = new AgentExporter({ url, logger })
      const start = new Date()
      const end = new Date()
      const tags = {
        'runtime-id': 'a1b2c3d4-a1b2-a1b2-a1b2-a1b2c3d4e5f6'
      }

      const [ cpu, heap ] = await Promise.all([
        createProfile(['wall', 'microseconds']),
        createProfile(['space', 'bytes'])
      ])

      const profiles = {
        cpu,
        heap
      }

      await new Promise((resolve, reject) => {
        app.post('/profiling/v1/input', upload.any(), (req, res) => {
          try {
            expect(req.body).to.have.property('language', 'javascript')
            expect(req.body).to.have.property('runtime', 'nodejs')
            expect(req.body).to.have.property('format', 'pprof')
            expect(req.body).to.have.deep.property('tags', [
              'language:javascript',
              'runtime:nodejs',
              'format:pprof',
              'runtime-id:a1b2c3d4-a1b2-a1b2-a1b2-a1b2c3d4e5f6'
            ])
            expect(req.body).to.have.deep.property('types', ['cpu', 'heap'])
            expect(req.body).to.have.property('recording-start', start.toISOString())
            expect(req.body).to.have.property('recording-end', end.toISOString())

            expect(req.files[0]).to.have.property('fieldname', 'data[0]')
            expect(req.files[0]).to.have.property('originalname', 'cpu.pb.gz')
            expect(req.files[0]).to.have.property('mimetype', 'application/octet-stream')
            expect(req.files[0]).to.have.property('size', req.files[0].buffer.length)

            expect(req.files[1]).to.have.property('fieldname', 'data[1]')
            expect(req.files[1]).to.have.property('originalname', 'heap.pb.gz')
            expect(req.files[1]).to.have.property('mimetype', 'application/octet-stream')
            expect(req.files[1]).to.have.property('size', req.files[1].buffer.length)

            const cpuProfile = decode(gunzipSync(req.files[0].buffer))
            const heapProfile = decode(gunzipSync(req.files[1].buffer))

            expect(cpuProfile).to.be.a.profile
            expect(heapProfile).to.be.a.profile

            expect(cpuProfile).to.deep.equal(decode(gunzipSync(profiles.cpu)))
            expect(heapProfile).to.deep.equal(decode(gunzipSync(profiles.heap)))

            resolve()
          } catch (e) {
            reject(e)
          }

          res.send()
        })

        exporter.export({ profiles, start, end, tags }).catch(reject)
      })
    })

    it('should log exports and handle http errors gracefully', async () => {
      const expectedLogs = [
        /^Building agent export report: (\n {2}[a-z-]+(\[\])?: [a-z0-9-TZ:.]+)+$/,
        /^Adding cpu profile to agent export:( [0-9a-f]{2})+$/,
        /^Adding heap profile to agent export:( [0-9a-f]{2})+$/,
        /^Submitting agent report to: {"[a-z]+":"[a-z0-9/.:]+"(,"[a-z]+":([0-9]+|"[a-z0-9/.:]+"))*}$/i,
        /^Agent export response: {"error":"some error"}$/
      ]
      const exporter = new AgentExporter({
        url,
        logger: {
          debug (message) {
            expect(typeof message === 'function' ? message() : message)
              .to.match(expectedLogs.shift())
          }
        }
      })
      const start = new Date()
      const end = new Date()
      const tags = { foo: 'bar' }

      const [ cpu, heap ] = await Promise.all([
        createProfile(['wall', 'microseconds']),
        createProfile(['space', 'bytes'])
      ])

      const profiles = {
        cpu,
        heap
      }

      await new Promise((resolve, reject) => {
        const json = JSON.stringify({ error: 'some error' })
        app.post('/profiling/v1/input', upload.any(), (req, res) => {
          const data = Buffer.from(json)
          res.writeHead(400, {
            'content-type': 'application/json',
            'content-length': data.length
          })
          res.end(data)
        })

        exporter.export({ profiles, start, end, tags }).catch(error => {
          expect(error.message).to.equal('Error from the agent: 400')
          resolve()
        })
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
      const exporter = new AgentExporter({ url: new URL(`unix://${url}`), logger })
      const start = new Date()
      const end = new Date()
      const tags = { foo: 'bar' }

      const [ cpu, heap ] = await Promise.all([
        createProfile(['wall', 'microseconds']),
        createProfile(['space', 'bytes'])
      ])

      const profiles = {
        cpu,
        heap
      }

      await new Promise((resolve, reject) => {
        app.post('/profiling/v1/input', upload.any(), (req, res) => {
          try {
            expect(req.body).to.have.property('language', 'javascript')
            expect(req.body).to.have.property('runtime', 'nodejs')
            expect(req.body).to.have.property('format', 'pprof')
            expect(req.body).to.have.deep.property('tags', [
              'language:javascript',
              'runtime:nodejs',
              'format:pprof',
              'foo:bar'
            ])
            expect(req.body).to.have.deep.property('types', ['cpu', 'heap'])
            expect(req.body).to.have.property('recording-start', start.toISOString())
            expect(req.body).to.have.property('recording-end', end.toISOString())

            expect(req.files[0]).to.have.property('fieldname', 'data[0]')
            expect(req.files[0]).to.have.property('originalname', 'cpu.pb.gz')
            expect(req.files[0]).to.have.property('mimetype', 'application/octet-stream')
            expect(req.files[0]).to.have.property('size', req.files[0].buffer.length)

            expect(req.files[1]).to.have.property('fieldname', 'data[1]')
            expect(req.files[1]).to.have.property('originalname', 'heap.pb.gz')
            expect(req.files[1]).to.have.property('mimetype', 'application/octet-stream')
            expect(req.files[1]).to.have.property('size', req.files[1].buffer.length)

            const cpuProfile = decode(gunzipSync(req.files[0].buffer))
            const heapProfile = decode(gunzipSync(req.files[1].buffer))

            expect(cpuProfile).to.be.a.profile
            expect(heapProfile).to.be.a.profile

            expect(cpuProfile).to.deep.equal(decode(gunzipSync(profiles.cpu)))
            expect(heapProfile).to.deep.equal(decode(gunzipSync(profiles.heap)))

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
