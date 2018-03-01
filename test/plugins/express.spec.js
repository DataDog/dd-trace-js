'use strict'

const axios = require('axios')
const bodyParser = require('body-parser')
const msgpack = require('msgpack-lite')
const codec = msgpack.createCodec({ int64: true })
const getPort = require('get-port')

describe('Plugin', () => {
  let plugin
  let context
  let express
  let tracer
  let agent
  let agentListener
  let appListener

  describe('express', () => {
    beforeEach(() => {
      plugin = require('../../src/plugins/express')
      express = require('express')
      context = require('../../src/platform').context({ experimental: { asyncHooks: false } })
      tracer = require('../..')

      return getPort().then(port => {
        agent = express()
        agent.use(bodyParser.raw({ type: 'application/msgpack' }))
        agent.use((req, res, next) => {
          req.body = msgpack.decode(req.body, { codec })
          next()
        })

        agentListener = agent.listen(port, 'localhost')

        plugin.patch(express, tracer)

        tracer.init({
          service: 'test',
          port,
          flushInterval: 10
        })
      })
    })

    afterEach(() => {
      agentListener.close()
      appListener.close()
      plugin.unpatch(express)
      delete require.cache[require.resolve('../..')]
    })

    it('should do automatic instrumentation', done => {
      const app = express()

      app.get('/user', (req, res) => {
        res.status(200).send()
      })

      getPort().then(port => {
        agent.put('/v0.3/traces', (req, res) => {
          expect(req.body[0][0]).to.have.property('type', 'web')
          expect(req.body[0][0]).to.have.property('resource', '/user')
          expect(req.body[0][0].meta).to.have.property('span.kind', 'server')
          expect(req.body[0][0].meta).to.have.property('http.url', `http://localhost:${port}/user`)
          expect(req.body[0][0].meta).to.have.property('http.method', 'GET')
          expect(req.body[0][0].meta).to.have.property('http.status_code', '200')

          res.status(200).send('OK')

          done()
        })

        appListener = app.listen(port, 'localhost', () => {
          axios
            .get(`http://localhost:${port}/user`)
            .catch(done)
        })
      })
    })

    it('should support custom routers', done => {
      const app = express()

      app.use((req, res) => {
        res.status(200).send()
      })

      getPort().then(port => {
        agent.put('/v0.3/traces', (req, res) => {
          expect(req.body[0][0]).to.have.property('resource', 'express.request')
          expect(req.body[0][0].meta).to.have.property('http.status_code', '200')

          res.status(200).send('OK')

          done()
        })

        appListener = app.listen(port, 'localhost', () => {
          axios
            .get(`http://localhost:${port}`)
            .catch(done)
        })
      })
    })

    it('should support context propagation', done => {
      const app = express()

      app.use((req, res, next) => {
        context.set('foo', 'bar')
        next()
      })

      app.get('/user', (req, res) => {
        res.status(200).send(context.get('foo'))
      })

      getPort().then(port => {
        appListener = app.listen(port, 'localhost', () => {
          axios.get(`http://localhost:${port}/user`)
            .then(res => {
              expect(res.status).to.equal(200)
              expect(res.data).to.equal('bar')
              done()
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
        res.status(400).send()
      })

      getPort().then(port => {
        agent.put('/v0.3/traces', (req, res) => {
          expect(req.body[0][0].meta).to.have.property('http.status_code', '400')
          expect(req.body[0][0].meta).to.have.property('error', 'true')

          res.status(200).send('OK')

          done()
        })

        appListener = app.listen(port, 'localhost', () => {
          axios
            .get(`http://localhost:${port}/user`, {
              validateStatus: status => status === 400
            })
            .catch(done)
        })
      })
    })

    it('should extract its parent span from the headers', done => {
      const app = express()

      app.get('/user', (req, res) => {
        expect(tracer.currentSpan().context().baggageItems).to.have.property('foo', 'bar')
        res.status(200).send()
      })

      getPort().then(port => {
        agent.put('/v0.3/traces', (req, res) => {
          expect(req.body[0][0].trace_id.toString()).to.equal('1234')
          expect(req.body[0][0].parent_id.toString()).to.equal('5678')

          res.status(200).send('OK')

          done()
        })

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
  })
})
