'use strict'

const axios = require('axios')
const getPort = require('get-port')
const agent = require('./agent')

wrapIt()

describe('Plugin', () => {
  let plugin
  let tracer
  let express
  let appListener

  describe('express', () => {
    beforeEach(() => {
      plugin = require('../../src/plugins/express')
      tracer = require('../..')
    })

    afterEach(() => {
      agent.close()
      appListener.close()
    })

    describe('without configuration', () => {
      beforeEach(() => {
        return agent.load(plugin, 'express')
          .then(() => {
            express = require('express')
          })
      })

      it('should do automatic instrumentation on app routes', done => {
        const app = express()

        app.get('/user', (req, res) => {
          res.status(200).send()
        })

        getPort().then(port => {
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('service', 'test')
              expect(traces[0][0]).to.have.property('type', 'http')
              expect(traces[0][0]).to.have.property('resource', 'GET /user')
              expect(traces[0][0].meta).to.have.property('span.kind', 'server')
              expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/user`)
              expect(traces[0][0].meta).to.have.property('http.method', 'GET')
              expect(traces[0][0].meta).to.have.property('http.status_code', '200')
            })
            .then(done)
            .catch(done)

          appListener = app.listen(port, 'localhost', () => {
            axios
              .get(`http://localhost:${port}/user`)
              .catch(done)
          })
        })
      })

      it('should do automatic instrumentation on routers', done => {
        const app = express()
        const router = express.Router()

        router.get('/user/:id', (req, res) => {
          res.status(200).send()
        })

        app.use('/app', router)

        getPort().then(port => {
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('service', 'test')
              expect(traces[0][0]).to.have.property('type', 'http')
              expect(traces[0][0]).to.have.property('resource', 'GET /app/user/:id')
              expect(traces[0][0].meta).to.have.property('span.kind', 'server')
              expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/app/user/1`)
              expect(traces[0][0].meta).to.have.property('http.method', 'GET')
              expect(traces[0][0].meta).to.have.property('http.status_code', '200')
            })
            .then(done)
            .catch(done)

          appListener = app.listen(port, 'localhost', () => {
            axios
              .get(`http://localhost:${port}/app/user/1`)
              .catch(done)
          })
        })
      })

      it('should surround matchers based on regular expressions', done => {
        const app = express()
        const router = express.Router()

        router.get(/^\/user\/(\d)$/, (req, res) => {
          res.status(200).send()
        })

        app.use('/app', router)

        getPort().then(port => {
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('resource', 'GET /app(/^\\/user\\/(\\d)$/)')
            })
            .then(done)
            .catch(done)

          appListener = app.listen(port, 'localhost', () => {
            axios
              .get(`http://localhost:${port}/app/user/1`)
              .catch(done)
          })
        })
      })

      it('should support a nested array of paths on the router', done => {
        const app = express()
        const router = express.Router()

        router.get([['/user/:id'], '/users/:id'], (req, res, next) => {
          res.status(200).send()
        })

        app.use('/app', router)

        getPort().then(port => {
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('resource', 'GET /app/user/:id')
            })
            .then(done)
            .catch(done)

          appListener = app.listen(port, 'localhost', () => {
            axios
              .get(`http://localhost:${port}/app/user/1`)
              .catch(done)
          })
        })
      })

      it('should only keep the last matching path of a middleware stack', done => {
        const app = express()
        const router = express.Router()

        router.use('/', (req, res, next) => next())
        router.use('*', (req, res, next) => next())
        router.use('/bar', (req, res, next) => next())
        router.use('/bar', (req, res, next) => {
          res.status(200).send()
        })

        app.use('/', (req, res, next) => next())
        app.use('*', (req, res, next) => next())
        app.use('/foo/bar', (req, res, next) => next())
        app.use('/foo', router)

        getPort().then(port => {
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('resource', 'GET /foo/bar')
            })
            .then(done)
            .catch(done)

          appListener = app.listen(port, 'localhost', () => {
            axios
              .get(`http://localhost:${port}/foo/bar`)
              .catch(done)
          })
        })
      })

      it('should support asynchronous routers', done => {
        const app = express()
        const router = express.Router()

        router.get('/user/:id', (req, res) => {
          setTimeout(() => res.status(200).send())
        })

        app.use('/app', router)

        getPort().then(port => {
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('resource', 'GET /app/user/:id')
            })
            .then(done)
            .catch(done)

          appListener = app.listen(port, 'localhost', () => {
            axios
              .get(`http://localhost:${port}/app/user/1`)
              .catch(done)
          })
        })
      })

      it('should support asynchronous middlewares', done => {
        const app = express()
        const router = express.Router()

        router.use((req, res, next) => setTimeout(() => next()))
        router.get('/user/:id', (req, res) => {
          res.status(200).send()
        })

        app.use('/app', router)

        getPort().then(port => {
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('resource', 'GET /app/user/:id')
            })
            .then(done)
            .catch(done)

          appListener = app.listen(port, 'localhost', () => {
            axios
              .get(`http://localhost:${port}/app/user/1`)
              .catch(done)
          })
        })
      })

      it('should not lose the current path when changing scope', done => {
        const app = express()
        const router = express.Router()

        router.use((req, res, next) => {
          const scope = tracer.scopeManager().active()
          const child = tracer.startSpan('child', {
            childOf: scope.span()
          })

          tracer.scopeManager().activate(child)

          child.finish()

          next()
        })

        router.get('/user/:id', (req, res) => {
          res.status(200).send()
        })

        app.use('/app', router)

        getPort().then(port => {
          agent
            .use(traces => {
              expect(traces[0][1]).to.have.property('resource', 'GET /app/user/:id')
            })
            .then(done)
            .catch(done)

          appListener = app.listen(port, 'localhost', () => {
            axios
              .get(`http://localhost:${port}/app/user/123`)
              .catch(done)
          })
        })
      })

      it('should fallback to the the verb if a path pattern could not be found', done => {
        const app = express()

        app.use((req, res, next) => res.status(200).send())

        getPort().then(port => {
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('resource', 'GET')
            })
            .then(done)
            .catch(done)

          appListener = app.listen(port, 'localhost', () => {
            axios
              .get(`http://localhost:${port}/app`)
              .catch(done)
          })
        })
      })

      it('should support context propagation', done => {
        const app = express()
        const span = tracer.startSpan('test')

        let scope

        app.use((req, res, next) => {
          scope = tracer.scopeManager().activate(span)
          next()
        })

        app.get('/user', (req, res) => {
          res.status(200).send()
          expect(tracer.scopeManager().active()).to.equal(scope)
          done()
        })

        getPort().then(port => {
          appListener = app.listen(port, 'localhost', () => {
            axios.get(`http://localhost:${port}/user`)
              .catch(done)
          })
        })
      })

      it('should only include paths for routes that matched', done => {
        const app = express()
        const router = express.Router()

        router.use('/baz', (req, res, next) => next())
        router.get('/user/:id', (req, res) => {
          res.status(200).send()
        })
        router.use('/qux', (req, res, next) => next())

        app.use('/foo', (req, res, next) => next())
        app.use('/app', router)
        app.use('/bar', (req, res, next) => next())

        getPort().then(port => {
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('resource', 'GET /app/user/:id')
            })
            .then(done)
            .catch(done)

          appListener = app.listen(port, 'localhost', () => {
            axios.get(`http://localhost:${port}/app/user/123`)
              .then(res => {
                expect(res.status).to.equal(200)
                expect(res.data).to.be.empty
                done()
              })
              .catch(done)
          })
        })
      })

      it('should extract its parent span from the headers', done => {
        const app = express()

        app.get('/user', (req, res) => {
          res.status(200).send()
        })

        getPort().then(port => {
          agent.use(traces => {
            expect(traces[0][0].trace_id.toString()).to.equal('1234')
            expect(traces[0][0].parent_id.toString()).to.equal('5678')
          })
            .then(done)
            .catch(done)

          appListener = app.listen(port, 'localhost', () => {
            axios
              .get(`http://localhost:${port}/user`, {
                headers: {
                  'x-datadog-trace-id': '1234',
                  'x-datadog-parent-id': '5678',
                  'ot-baggage-foo': 'bar'
                }
              })
              .catch(done)
          })
        })
      })

      it('should handle errors', done => {
        const app = express()

        app.use((req, res, next) => {
          next()
        })

        app.get('/user', (req, res) => {
          res.status(500).send()
        })

        getPort().then(port => {
          agent.use(traces => {
            expect(traces[0][0]).to.have.property('error', 1)
            expect(traces[0][0]).to.have.property('resource', 'GET /user')
            expect(traces[0][0].meta).to.have.property('http.status_code', '500')

            done()
          })

          appListener = app.listen(port, 'localhost', () => {
            axios
              .get(`http://localhost:${port}/user`, {
                validateStatus: status => status === 500
              })
              .catch(done)
          })
        })
      })
    })

    describe('with configuration', () => {
      let config

      beforeEach(() => {
        config = {
          service: 'custom',
          validateStatus: code => code < 400
        }

        return agent.load(plugin, 'express', config)
          .then(() => {
            express = require('express')
          })
      })

      it('should be configured with the correct service name', done => {
        const app = express()

        app.get('/user', (req, res) => {
          res.status(200).send()
        })

        getPort().then(port => {
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('service', 'custom')
            })
            .then(done)
            .catch(done)

          appListener = app.listen(port, 'localhost', () => {
            axios
              .get(`http://localhost:${port}/user`)
              .catch(done)
          })
        })
      })

      it('should be configured with the correct status code validator', done => {
        const app = express()

        app.get('/user', (req, res) => {
          res.status(400).send()
        })

        getPort().then(port => {
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('error', 1)
            })
            .then(done)
            .catch(done)

          appListener = app.listen(port, 'localhost', () => {
            axios
              .get(`http://localhost:${port}/user`, {
                validateStatus: status => status === 400
              })
              .catch(done)
          })
        })
      })
    })
  })
})
