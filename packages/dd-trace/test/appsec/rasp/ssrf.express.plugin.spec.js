'use strict'

const assert = require('node:assert/strict')

const path = require('node:path')

const Axios = require('axios')
const { describe, it, beforeEach, before, after } = require('mocha')

const { getConfigFresh } = require('../../helpers/config')
const agent = require('../../plugins/agent')
const appsec = require('../../../src/appsec')
const { withVersions } = require('../../setup/mocha')
const { checkRaspExecutedAndNotThreat, checkRaspExecutedAndHasThreat } = require('./utils')

function noop () {}

describe('RASP - ssrf', () => {
  withVersions('express', 'express', expressVersion => {
    let app, server, axios

    before(() => {
      require('events').defaultMaxListeners = 7
      return agent.load(['express', 'http'], { client: false })
    })

    before((done) => {
      const express = require(`../../../../../versions/express@${expressVersion}`).get()
      const expressApp = express()

      expressApp.get('/', (req, res) => {
        app(req, res)
      })

      appsec.enable(getConfigFresh({
        appsec: {
          enabled: true,
          rules: path.join(__dirname, 'resources', 'rasp_rules.json'),
          rasp: { enabled: true },
        },
      }))

      server = expressApp.listen(0, () => {
        const port = (/** @type {import('net').AddressInfo} */ (server.address())).port
        axios = Axios.create({
          baseURL: `http://localhost:${port}`,
        })
        done()
      })
    })

    after(() => {
      appsec.disable()
      server.close()
      return agent.close({ ritmReset: false })
    })

    describe('ssrf', () => {
      async function testBlockingRequest () {
        const assertPromise = checkRaspExecutedAndHasThreat(agent, 'rasp-ssrf-rule-id-1')
        const blockingRequestPromise = axios.get('/?host=localhost/ifconfig.pro').then(() => {
          assert.fail('Request should be blocked')
        }).catch(e => {
          if (!e.response) {
            throw e
          }
        })

        await Promise.all([
          blockingRequestPromise,
          assertPromise,
        ])
      }

      ['http', 'https'].forEach(protocol => {
        describe(`Test using ${protocol}`, () => {
          it('Should not detect threat', async () => {
            // Hack to enforce the module to be loaded once before the actual request
            const module = require(protocol)

            app = (req, res) => {
              const clientRequest = module.get(`${protocol}://${req.query.host}`, function (incomingResponse) {
                incomingResponse.resume()
                res.end('end')
              })

              clientRequest.on('error', noop)
            }

            await Promise.all([
              checkRaspExecutedAndNotThreat(agent),
              axios.get('/?host=www.datadoghq.com'),
            ])
          })

          it('Should detect threat doing a GET request', async () => {
            app = (req, res) => {
              const clientRequest = require(protocol).get(`${protocol}://${req.query.host}`)
              clientRequest.on('error', (e) => {
                if (e.message === 'DatadogRaspAbortError') {
                  res.writeHead(500)
                }
                res.end('end')
              })
            }

            await testBlockingRequest()
          })

          it('Should detect threat doing a POST request', async () => {
            app = (req, res) => {
              const clientRequest = require(protocol)
                .request(`${protocol}://${req.query.host}`, { method: 'POST' })
              clientRequest.write('dummy_post_data')
              clientRequest.end()
              clientRequest.on('error', (e) => {
                if (e.message === 'DatadogRaspAbortError') {
                  res.writeHead(500)
                }
                res.end('end')
              })
            }

            await testBlockingRequest()
          })
        })
      })

      describe('Test using axios', () => {
        withVersions('express', 'axios', axiosVersion => {
          let axiosToTest

          beforeEach((done) => {
            axiosToTest = require(`../../../../../versions/axios@${axiosVersion}`).get()

            // we preload axios because it's lazyloading a debug dependency
            // that in turns trigger LFI

            axiosToTest.get('http://preloadaxios', { timeout: 10 }).catch(noop).then(done)
          })

          it('Should not detect threat', async () => {
            app = (req, res) => {
              axiosToTest.get(`https://${req.query.host}`)
                .catch(noop) // swallow network error
                .then(() => res.end('end'))
            }

            await Promise.all([
              axios.get('/?host=www.datadoghq.com'),
              checkRaspExecutedAndNotThreat(agent),
            ])
          })

          it('Should detect threat doing a GET request', async () => {
            app = async (req, res) => {
              try {
                await axiosToTest.get(`https://${req.query.host}`)
                res.end('end')
              } catch (e) {
                if (e.cause.message === 'DatadogRaspAbortError') {
                  res.writeHead(500)
                }
                res.end('end')
              }
            }

            await testBlockingRequest()
          })

          it('Should detect threat doing a POST request', async () => {
            app = async (req, res) => {
              try {
                await axiosToTest.post(`https://${req.query.host}`, { key: 'value' })
              } catch (e) {
                if (e.cause.message === 'DatadogRaspAbortError') {
                  res.writeHead(500)
                }
                res.end('end')
              }
            }

            await testBlockingRequest()
          })
        })
      })

      describe('Test using request', () => {
        withVersions('express', 'request', requestVersion => {
          let requestToTest

          beforeEach(() => {
            requestToTest = require(`../../../../../versions/request@${requestVersion}`).get()
          })

          it('Should not detect threat', async () => {
            app = (req, res) => {
              requestToTest.get(`https://${req.query.host}`).on('response', () => {
                res.end('end')
              })
            }

            await Promise.all([
              axios.get('/?host=www.datadoghq.com'),
              checkRaspExecutedAndNotThreat(agent),
            ])
          })

          it('Should detect threat doing a GET request', async () => {
            app = async (req, res) => {
              try {
                requestToTest.get(`https://${req.query.host}`)
                  .on('error', (e) => {
                    if (e.message === 'DatadogRaspAbortError') {
                      res.writeHead(500)
                    }
                    res.end('end')
                  })
              } catch (e) {
                if (e.cause.message === 'DatadogRaspAbortError') {
                  res.writeHead(500)
                }
                res.end('end')
              }
            }

            await testBlockingRequest()
          })
        })
      })
    })
  })

  describe('without express', () => {
    let app, server, axios

    before(() => {
      return agent.load(['http'], { client: false })
    })

    before((done) => {
      const http = require('http')
      server = http.createServer((req, res) => {
        if (app) {
          app(req, res)
        } else {
          res.end('end')
        }
      })

      appsec.enable(getConfigFresh({
        appsec: {
          enabled: true,
          rules: path.join(__dirname, 'resources', 'rasp_rules.json'),
          rasp: { enabled: true },
        },
      }))

      server.listen(0, () => {
        const port = (/** @type {import('net').AddressInfo} */ (server.address())).port
        axios = Axios.create({
          baseURL: `http://localhost:${port}`,
        })

        done()
      })
    })

    after(() => {
      appsec.disable()
      server.close()
      return agent.close({ ritmReset: false })
    })

    it('Should detect threat without blocking doing a GET request', async () => {
      app = (req, res) => {
        const clientRequest = require('http').get(`http://${req.headers.host}`, { timeout: 10 }, function () {
          res.end('end')
        })

        clientRequest.on('timeout', () => {
          res.writeHead(200)
          res.end('timeout')
        })

        clientRequest.on('error', (e) => {
          if (e.name !== 'DatadogRaspAbortError') {
            res.writeHead(200)
            res.end('not-blocking-error')
          } else {
            res.writeHead(500)
            res.end('unexpected-blocking-error')
          }
        })
      }

      const response = await axios.get('/', {
        headers: {
          host: 'localhost/ifconfig.pro',
        },
      })

      assert.strictEqual(response.status, 200)

      return checkRaspExecutedAndHasThreat(agent, 'rasp-ssrf-rule-id-1')
    })
  })
})
