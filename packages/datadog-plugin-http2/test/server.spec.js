'use strict'

const fs = require('fs')
const path = require('path')
const getPort = require('get-port')
const agent = require('../../dd-trace/test/plugins/agent')
const key = fs.readFileSync(path.join(__dirname, './ssl/test.key'))
const cert = fs.readFileSync(path.join(__dirname, './ssl/test.crt'))

const describe = () => {} // temporarily disable HTTP2 server plugin tests

const { SAMPLING_PRIORITY_KEY } = require('../../dd-trace/src/constants')
const { USER_REJECT } = require('../../../ext/priority')

describe('Plugin', () => {
  let http2
  let app
  let appListener
  let tracer
  let port
  let server
  let client

  describe('http2/server', () => {
    beforeEach(() => {
      tracer = require('../../dd-trace')
    })

    beforeEach(() => {
      return getPort().then(newPort => {
        port = newPort
      })
    })

    afterEach(() => {
      app = undefined
      appListener && appListener.close()
      client && client.close()
      server && server.close()
    })

    describe('without configuration', () => {
      beforeEach(() => {
        return agent.load('http2')
          .then(() => {
            http2 = require('http2')
          })
      })

      afterEach(() => agent.close())

      describe('using the modern stream API', () => {
        beforeEach(done => {
          const options = { key, cert }
          server = http2.createServer(options)
          server.on('stream', (stream, headers) => {
            app && app(stream, headers)
            stream.respond({
              'content-type': 'text/html',
              ':status': 200
            })
            stream.end()
          })
          appListener = server.listen(port, 'localhost', (err) => {
            client = http2.connect(`http://localhost:${port}`)
            done(err)
          })
        })

        it('should do automatic instrumentation', done => {
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('name', 'http.request')
              expect(traces[0][0]).to.have.property('service', 'test')
              expect(traces[0][0]).to.have.property('type', 'web')
              expect(traces[0][0]).to.have.property('resource', 'GET')
              expect(traces[0][0].meta).to.have.property('span.kind', 'server')
              expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/user`)
              expect(traces[0][0].meta).to.have.property('http.method', 'GET')
              expect(traces[0][0].meta).to.have.property('http.status_code', '200')
            })
            .then(done)
            .catch(done)

          client
            .request({ ':path': '/user' })
            .on('error', done)
        })

        it('should run the request listener in the request scope', done => {
          app = (stream, headers) => {
            expect(tracer.scope().active()).to.not.be.null
            done()
          }

          client
            .request({ ':path': '/user' })
            .on('error', done)
        })
      })

      describe('using the compatibility API', () => {
        beforeEach(done => {
          const options = { key, cert }
          server = http2.createServer(options, (req, res) => {
            app && app(req, res)
            res.write(200)
            res.end()
          })
          appListener = server.listen(port, 'localhost', (err) => {
            client = http2.connect(`http://localhost:${port}`)
            done(err)
          })
        })

        it('should do automatic instrumentation', done => {
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('name', 'http.request')
              expect(traces[0][0]).to.have.property('service', 'test')
              expect(traces[0][0]).to.have.property('type', 'web')
              expect(traces[0][0]).to.have.property('resource', 'GET')
              expect(traces[0][0].meta).to.have.property('span.kind', 'server')
              expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/user`)
              expect(traces[0][0].meta).to.have.property('http.method', 'GET')
              expect(traces[0][0].meta).to.have.property('http.status_code', '200')
            })
            .then(done)
            .catch(done)

          client
            .request({ ':path': '/user' })
            .on('error', done)
        })

        it('should run the request listener in the request scope', done => {
          app = (req, res) => {
            expect(tracer.scope().active()).to.not.be.null
            done()
          }

          client
            .request({ ':path': '/user' })
            .on('error', done)
        })
      })
    })

    describe('with a blocklist configuration', () => {
      beforeEach(() => {
        return agent.load('http2', { blocklist: '/health' })
          .then(() => {
            http2 = require('http2')
          })
      })

      afterEach(() => agent.close())

      it('should drop filtered out requests', done => {
        agent
          .use(traces => {
            expect(traces[0][0]).to.have.property('name', 'http.request')
            expect(traces[0][0]).to.have.property('service', 'test')
            expect(traces[0][0]).to.have.property('type', 'web')
            expect(traces[0][0]).to.have.property('resource', 'GET /health')
            expect(traces[0][0].meta).to.have.property('span.kind', 'server')
            expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/health`)
            expect(traces[0][0].meta).to.have.property('http.method', 'GET')
            expect(traces[0][0].meta).to.have.property('http.status_code', '200')
            expect(traces[0][0].metrics).to.have.property(SAMPLING_PRIORITY_KEY, USER_REJECT)
          })
          .then(done)
          .catch(done)

        client
          .request({ ':path': '/user' })
          .on('error', done)
      })
    })
  })
})
