'use strict'

const getPort = require('get-port')
const agent = require('./agent')

wrapIt()

describe('Plugin', () => {
  let plugin
  let express
  let http
  let appListener
  let tracer

  describe('http', () => {
    beforeEach(() => {
      plugin = require('../../src/plugins/http')
      tracer = require('../..')
    })

    afterEach(() => {
      appListener.close()
      return agent.close()
    })

    describe('without configuration', () => {
      beforeEach(() => {
        return agent.load(plugin, 'http')
          .then(() => {
            http = require('http')
            express = require('express')
          })
      })

      it('should do automatic instrumentation', done => {
        const app = express()

        app.get('/user', (req, res) => {
          res.status(200).send()
        })

        getPort().then(port => {
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('service', 'test-http-client')
              expect(traces[0][0]).to.have.property('type', 'web')
              expect(traces[0][0]).to.have.property('resource', 'GET')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/user`)
              expect(traces[0][0].meta).to.have.property('http.method', 'GET')
              expect(traces[0][0].meta).to.have.property('http.status_code', '200')
            })
            .then(done)
            .catch(done)

          appListener = app.listen(port, 'localhost', () => {
            const req = http.request(`http://localhost:${port}/user`, res => {
              res.on('data', () => {})
            })

            req.end()
          })
        })
      })

      it('should also support http.get', done => {
        const app = express()

        app.get('/user', (req, res) => {
          res.status(200).send()
        })

        getPort().then(port => {
          agent
            .use(traces => {
              expect(traces[0][0]).to.not.be.undefined
            })
            .then(done)
            .catch(done)

          appListener = app.listen(port, 'localhost', () => {
            const req = http.get(`http://localhost:${port}/user`, res => {
              res.on('data', () => {})
            })

            req.end()
          })
        })
      })

      it('should support configuration as an URL object', done => {
        getPort().then(port => {
          agent
            .use(traces => {
              expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/user`)
            })
            .then(done)
            .catch(done)

          const uri = {
            hostname: 'localhost',
            port,
            pathname: '/user'
          }

          const req = http.request(uri)

          req.end()
        })
      })

      it('should use the correct defaults when not specified', done => {
        getPort().then(port => {
          agent
            .use(traces => {
              expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/`)
            })
            .then(done)
            .catch(done)

          const req = http.request({
            port
          })

          req.end()
        })
      })

      it('should not require consuming the data', done => {
        const app = express()

        app.get('/user', (req, res) => {
          res.status(200).send()
        })

        getPort().then(port => {
          agent
            .use(traces => {
              expect(traces[0][0]).to.not.be.undefined
            })
            .then(done)
            .catch(done)

          appListener = app.listen(port, 'localhost', () => {
            const req = http.request(`http://localhost:${port}/user`)

            req.end()
          })
        })
      })

      it('should wait for other listeners before resuming the response stream', done => {
        const app = express()

        app.get('/user', (req, res) => {
          res.status(200).send('OK')
        })

        getPort().then(port => {
          appListener = app.listen(port, 'localhost', () => {
            const req = http.request(`http://localhost:${port}/user`, res => {
              setTimeout(() => {
                res.on('data', () => done())
              })
            })

            req.end()
          })
        })
      })

      it('should inject its parent span in the headers', done => {
        const app = express()

        app.get('/user', (req, res) => {
          expect(req.get('x-datadog-trace-id')).to.be.a('string')
          expect(req.get('x-datadog-parent-id')).to.be.a('string')

          res.status(200).send()
        })

        getPort().then(port => {
          agent
            .use(traces => {
              expect(traces[0][0].meta).to.have.property('http.status_code', '200')
            })
            .then(done)
            .catch(done)

          appListener = app.listen(port, 'localhost', () => {
            const req = http.request(`http://localhost:${port}/user`)

            req.end()
          })
        })
      })

      it('should skip injecting if the Authorization header contains an AWS signature', done => {
        const app = express()

        app.get('/', (req, res) => {
          try {
            expect(req.get('x-datadog-trace-id')).to.be.undefined
            expect(req.get('x-datadog-parent-id')).to.be.undefined

            res.status(200).send()

            done()
          } catch (e) {
            done(e)
          }
        })

        getPort().then(port => {
          appListener = app.listen(port, 'localhost', () => {
            const req = http.request({
              port,
              headers: {
                Authorization: 'AWS4-HMAC-SHA256 ...'
              }
            })

            req.end()
          })
        })
      })

      it('should skip injecting if one of the Authorization headers contains an AWS signature', done => {
        const app = express()

        app.get('/', (req, res) => {
          try {
            expect(req.get('x-datadog-trace-id')).to.be.undefined
            expect(req.get('x-datadog-parent-id')).to.be.undefined

            res.status(200).send()

            done()
          } catch (e) {
            done(e)
          }
        })

        getPort().then(port => {
          appListener = app.listen(port, 'localhost', () => {
            const req = http.request({
              port,
              headers: {
                Authorization: ['AWS4-HMAC-SHA256 ...']
              }
            })

            req.end()
          })
        })
      })

      it('should skip injecting if the X-Amz-Signature header is set', done => {
        const app = express()

        app.get('/', (req, res) => {
          try {
            expect(req.get('x-datadog-trace-id')).to.be.undefined
            expect(req.get('x-datadog-parent-id')).to.be.undefined

            res.status(200).send()

            done()
          } catch (e) {
            done(e)
          }
        })

        getPort().then(port => {
          appListener = app.listen(port, 'localhost', () => {
            const req = http.request({
              port,
              headers: {
                'X-Amz-Signature': 'abc123'
              }
            })

            req.end()
          })
        })
      })

      it('should skip injecting if the X-Amz-Signature query param is set', done => {
        const app = express()

        app.get('/', (req, res) => {
          try {
            expect(req.get('x-datadog-trace-id')).to.be.undefined
            expect(req.get('x-datadog-parent-id')).to.be.undefined

            res.status(200).send()

            done()
          } catch (e) {
            done(e)
          }
        })

        getPort().then(port => {
          appListener = app.listen(port, 'localhost', () => {
            const req = http.request({
              port,
              path: '/?X-Amz-Signature=abc123'
            })

            req.end()
          })
        })
      })

      it('should run the callback in the parent context', done => {
        const app = express()

        app.get('/user', (req, res) => {
          res.status(200).send('OK')
        })

        getPort().then(port => {
          appListener = app.listen(port, 'localhost', () => {
            const req = http.request(`http://localhost:${port}/user`, res => {
              expect(tracer.scopeManager().active()).to.be.null
              done()
            })

            req.end()
          })
        })
      })

      it('should run the event listeners in the parent context', done => {
        const app = express()

        app.get('/user', (req, res) => {
          res.status(200).send('OK')
        })

        getPort().then(port => {
          appListener = app.listen(port, 'localhost', () => {
            const req = http.request(`http://localhost:${port}/user`, res => {
              res.on('data', () => {})
              res.on('end', () => {
                expect(tracer.scopeManager().active()).to.be.null
                done()
              })
            })

            req.end()
          })
        })
      })

      it('should handle errors', done => {
        getPort().then(port => {
          agent
            .use(traces => {
              expect(traces[0][0].meta).to.have.property('error.type', 'Error')
              expect(traces[0][0].meta).to.have.property('error.msg', `connect ECONNREFUSED 127.0.0.1:${port}`)
              expect(traces[0][0].meta).to.have.property('error.stack')
            })
            .then(done)
            .catch(done)

          const req = http.request(`http://localhost:${port}/user`)

          req.end()
        })
      })
    })

    describe('with service configuration', () => {
      let config

      beforeEach(() => {
        config = {
          service: 'custom'
        }

        return agent.load(plugin, 'http', config)
          .then(() => {
            http = require('http')
            express = require('express')
          })
      })

      it('should be configured with the correct values', done => {
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
            const req = http.request(`http://localhost:${port}/user`, res => {
              res.on('data', () => {})
            })

            req.end()
          })
        })
      })
    })

    describe('with splitByDomain configuration', () => {
      let config

      beforeEach(() => {
        config = {
          splitByDomain: true
        }

        return agent.load(plugin, 'http', config)
          .then(() => {
            http = require('http')
            express = require('express')
          })
      })

      it('should use the remote endpoint as the service name', done => {
        const app = express()

        app.get('/user', (req, res) => {
          res.status(200).send()
        })

        getPort().then(port => {
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('service', `localhost:${port}`)
            })
            .then(done)
            .catch(done)

          appListener = app.listen(port, 'localhost', () => {
            const req = http.request(`http://localhost:${port}/user`, res => {
              res.on('data', () => {})
            })

            req.end()
          })
        })
      })
    })
  })
})
