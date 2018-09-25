'use strict'

const axios = require('axios')
const getPort = require('get-port')
const agent = require('./agent')
const plugin = require('../../src/plugins/restify')

wrapIt()

describe('Plugin', () => {
  let tracer
  let restify
  let appListener

  describe('restify', () => {
    withVersions(plugin, 'restify', version => {
      beforeEach(() => {
        tracer = require('../..')
        restify = require(`./versions/restify@${version}`).get()
      })

      afterEach(() => {
        appListener.close()
      })

      describe('without configuration', () => {
        before(() => agent.load(plugin, 'restify'))
        after(() => agent.close())

        it('should do automatic instrumentation', done => {
          const server = restify.createServer()

          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('name', 'restify.request')
                expect(traces[0][0]).to.have.property('service', 'test')
                expect(traces[0][0]).to.have.property('type', 'http')
                expect(traces[0][0]).to.have.property('resource', 'GET')
                expect(traces[0][0].meta).to.have.property('span.kind', 'server')
                expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/user`)
                expect(traces[0][0].meta).to.have.property('http.method', 'GET')
                expect(traces[0][0].meta).to.have.property('http.status_code', '404')
              })
              .then(done)
              .catch(done)

            appListener = server.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user`)
                .catch(() => {})
            })
          })
        })

        it('should support routing', done => {
          const server = restify.createServer()

          server.get('/user/:id', (req, res, next) => {
            res.send(200)
            return next()
          })

          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('resource', 'GET /user/:id')
                expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/user/123`)
              })
              .then(done)
              .catch(done)

            appListener = server.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user/123`)
                .catch(done)
            })
          })
        })

        it('should run handlers in the request scope', done => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

          const server = restify.createServer()

          server.pre((req, res, next) => {
            expect(tracer.scopeManager().active()).to.not.be.null
            next()
          })

          server.use((req, res, next) => {
            expect(tracer.scopeManager().active()).to.not.be.null
            next()
          })

          server.get('/user', (req, res, next) => {
            expect(tracer.scopeManager().active()).to.not.be.null
            res.send(200)
            done()
            next()
          })

          getPort().then(port => {
            appListener = server.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user`)
                .catch(done)
            })
          })
        })

        it('should reactivate the request span in middleware scopes', done => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

          const server = restify.createServer()

          let span

          server.use((req, res, next) => {
            span = tracer.scopeManager().active().span()
            tracer.scopeManager().activate({})
            next()
          })

          server.use((req, res, next) => {
            expect(tracer.scopeManager().active().span()).to.equal(span)
            next()
          })

          server.get('/user', (req, res, next) => {
            res.send(200)
            done()
            next()
          })

          getPort().then(port => {
            appListener = server.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user`)
                .catch(done)
            })
          })
        })
      })
    })
  })
})
