'use strict'

const expect = require('chai').expect
const express = require('express')
const upload = require('multer')()
const os = require('os')
const path = require('path')
const getPort = require('get-port')
const { gunzipSync } = require('zlib')
const { perftools } = require('../../../../../protobuf/profile')
const { Profile } = require('../../../src/profiling/profile')

const { decode, encode } = perftools.profiles.Profile

const createProfile = (periodType) => {
  const profile = new Profile([periodType], periodType, 1000)
  const functionId = profile.addFunction('test', 'internal/test.js').id
  const locationId = profile.addLocation(functionId, 1, 18).id

  profile.addSample(locationId, [1000])

  return profile
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
        url = `http://127.0.0.1:${port}`

        listener = app.listen(port, '127.0.0.1', done)
        listener.on('connection', socket => sockets.push(socket))
      })
    })

    afterEach(done => {
      listener.close(done)
      sockets.forEach(socket => socket.end())
    })

    it('should send profiles as pprof to the intake', done => {
      const exporter = new AgentExporter({ url })
      const start = new Date()
      const end = new Date()
      const tags = { foo: 'bar' }
      const profiles = {
        cpu: createProfile(['wall', 'microseconds']),
        heap: createProfile(['space', 'bytes'])
      }

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

          expect(cpuProfile).to.deep.equal(decode(encode(profiles.cpu).finish()))
          expect(heapProfile).to.deep.equal(decode(encode(profiles.heap).finish()))

          done()
        } catch (e) {
          done(e)
        }

        res.send()
      })

      exporter.export({ profiles, start, end, tags }, e => e && done(e))
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

    it('should support Unix domain sockets', done => {
      const exporter = new AgentExporter({ url: `unix://${url}` })
      const start = new Date()
      const end = new Date()
      const tags = { foo: 'bar' }
      const profiles = {
        cpu: createProfile(['wall', 'microseconds']),
        heap: createProfile(['space', 'bytes'])
      }

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

          expect(cpuProfile).to.deep.equal(decode(encode(profiles.cpu).finish()))
          expect(heapProfile).to.deep.equal(decode(encode(profiles.heap).finish()))

          done()
        } catch (e) {
          done(e)
        }

        res.send()
      })

      exporter.export({ profiles, start, end, tags }, e => e && done(e))
    })
  })
})
