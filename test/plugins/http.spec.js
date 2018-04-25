'use strict'

const getPort = require('get-port')
const agent = require('./agent')

describe('Plugin', () => {
  let plugin
  let express
  let http
  let appListener

  describe('http', () => {
    beforeEach(() => {
      plugin = require('../../src/plugins/http')
      express = require('express')
      http = require('http')
    })

    afterEach(() => {
      agent.close()
      appListener.close()
    })

    describe('without configuration', () => {
      beforeEach(() => {
        return agent.load(plugin, http)
      })

      it('should do automatic instrumentation', done => {
        const app = express()

        app.get('/user', (req, res) => {
          res.status(200).send()
        })

        getPort().then(port => {
          agent.use(traces => {
            expect(traces[0][0]).to.have.property('service', 'http-client')
            expect(traces[0][0]).to.have.property('type', 'web')
            expect(traces[0][0]).to.have.property('resource', '/user')
            expect(traces[0][0].meta).to.have.property('span.kind', 'client')
            expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/user`)
            expect(traces[0][0].meta).to.have.property('http.method', 'GET')
            expect(traces[0][0].meta).to.have.property('http.status_code', '200')

            done()
          })

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
          agent.use(traces => {
            expect(traces[0][0]).to.not.be.undefined

            done()
          })

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
          agent.use(traces => {
            expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/user`)

            done()
          })

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
          agent.use(traces => {
            expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/`)

            done()
          })

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
          agent.use(traces => {
            expect(traces[0][0]).to.not.be.undefined

            done()
          })

          appListener = app.listen(port, 'localhost', () => {
            const req = http.request(`http://localhost:${port}/user`)

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
          agent.use(traces => {
            expect(traces[0][0].meta).to.have.property('http.status_code', '200')

            done()
          })

          appListener = app.listen(port, 'localhost', () => {
            const req = http.request(`http://localhost:${port}/user`)

            req.end()
          })
        })
      })

      it('should handle errors', done => {
        getPort().then(port => {
          agent.use(traces => {
            expect(traces[0][0].meta).to.have.property('error.type', 'Error')
            expect(traces[0][0].meta).to.have.property('error.msg', `connect ECONNREFUSED 127.0.0.1:${port}`)
            expect(traces[0][0].meta).to.have.property('error.stack')

            done()
          })

          const req = http.request(`http://localhost:${port}/user`)

          req.end()
        })
      })
    })

    describe('with configuration', () => {
      let config

      beforeEach(() => {
        config = {
          service: 'custom'
        }

        return agent.load(plugin, http, config)
      })

      it('should be configured with the correct values', done => {
        const app = express()

        app.get('/user', (req, res) => {
          res.status(200).send()
        })

        getPort().then(port => {
          agent.use(traces => {
            expect(traces[0][0]).to.have.property('service', 'custom')

            done()
          })

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
