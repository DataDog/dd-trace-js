'use strict'

const axios = require('axios')
const agent = require('../../plugins/agent')
const getPort = require('get-port')
const appsec = require('../../../src/appsec')
const Config = require('../../../src/config')
const path = require('path')

withVersions('express', 'express', expressVersion => {
  // unhandled error tests are defined as integration test because testing unhandled errors
  // are caught by the testing framework
  // - integration-tests/appsec/index.spec.js
  describe('RASP', () => {
    let app, server, port
    before(() => {
      return agent.load(['express', 'http'], { client: false }, { flushInterval: 1 })
    })

    before((done) => {
      const express = require(`../../../../../versions/express@${expressVersion}`).get()
      const expressApp = express()

      expressApp.get('/', (req, res) => {
        app(req, res)
      })

      getPort().then(newPort => {
        port = newPort
        server = expressApp.listen(port, () => {
          done()
        })
      })
    })

    beforeEach(() => {
      appsec.enable(new Config({
        appsec: {
          enabled: true,
          rules: path.join(__dirname, 'rasp_rules.json')
        }
      }))
    })

    afterEach(() => {
      appsec.disable()
      app = null
    })

    after(() => {
      server.close()
      return agent.close({ ritmReset: false })
    })

    describe('ssrf', () => {
      ['http', 'https'].forEach(protocol => {
        describe(`Test using ${protocol}`, () => {
          it('Not blocking', (done) => {
            app = (req, res) => {
              require(protocol).get(`${protocol}://${req.query.host}`, () => {
                res.end('not-blocked')
              })
            }

            axios.get(`http://localhost:${port}/?host=www.datadoghq.com`).then(res => {
              expect(res.status).to.equal(200)
              expect(res.data).to.equal('not-blocked')
              done()
            }).catch(done)
          })

          it('Get operation should be blocked and catched', (done) => {
            app = (req, res) => {
              const clientRequest = require(protocol).get(`${protocol}://${req.query.host}`, () => {
                res.end('not-blocked')
              })
              clientRequest.on('error', (e) => {
                if (e.name !== 'AbortError') {
                  res.writeHead(500).end(e.message)
                  return
                }
                res.writeHead(403).end('blocked')
              })
            }

            axios.get(`http://localhost:${port}/?host=ifconfig.pro`)
              .then(() => {
                done(new Error('should be blocked'))
              })
              .catch(err => {
                try {
                  const res = err.response
                  expect(res.status).to.equal(403)
                  expect(res.data).to.equal('blocked')
                  done()
                } catch (e) {
                  done(e)
                }
              })
          })

          it('POST operation should be blocked and catched', (done) => {
            app = (req, res) => {
              const clientRequest = require(protocol)
                .request(`${protocol}://${req.query.host}`, { method: 'POST' }, () => {
                  res.end('not-blocked')
                })
              clientRequest.on('error', (e) => {
                if (e.name !== 'AbortError') {
                  res.writeHead(500).end(e.message)
                  return
                }
                res.writeHead(403).end('blocked')
              })
              clientRequest.flushHeaders()
              clientRequest.write('dummy_post_data')
              clientRequest.end()
            }

            axios.get(`http://localhost:${port}/?host=ifconfig.pro`)
              .then(() => {
                done(new Error('should be blocked'))
              })
              .catch(err => {
                try {
                  const res = err.response
                  expect(res.status).to.equal(403)
                  expect(res.data).to.equal('blocked')
                  done()
                } catch (e) {
                  done(e)
                }
              })
          })
        })
      })
    })
  })
})
