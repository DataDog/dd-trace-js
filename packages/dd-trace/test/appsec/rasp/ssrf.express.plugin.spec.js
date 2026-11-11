'use strict'

const assert = require('node:assert/strict')

const path = require('node:path')

const { describe, it, beforeEach, before, after } = require('mocha')

const { getConfigFresh } = require('../../helpers/config')
const agent = require('../../plugins/agent')
const appsec = require('../../../src/appsec')
const { json } = require('../../../src/appsec/blocking/templates')
const { withVersions } = require('../../setup/mocha')
const HttpRequest = require('../../setup/helpers/http-client')
const { checkRaspExecutedAndNotThreat, checkRaspExecutedAndHasThreat } = require('./utils')

function noop () {}

const NON_ROUTABLE_HOST = '192.0.2.1'

describe('RASP - ssrf', () => {
  withVersions('express', 'express', expressVersion => {
    let app, server, httpRequest

    before(() => {
      require('events').defaultMaxListeners = 7
      return agent.load(['express', 'http'], { client: false })
    })

    before((done) => {
      const express = require(`../../../../../versions/express@${expressVersion}`).get()
      const expressApp = express()

      expressApp.get('/', (req, res, next) => {
        app(req, res, next)
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
        httpRequest = HttpRequest.create({
          baseURL: `http://localhost:${port}`,
        })
        done()
      })
    })

    after(() => {
      appsec.disable()
      server.close()
      return agent.close()
    })

    describe('ssrf', () => {
      async function testBlockingRequest () {
        const assertPromise = checkRaspExecutedAndHasThreat(agent, 'rasp-ssrf-rule-id-1')
        const blockingRequestPromise = httpRequest.get('/?host=localhost/ifconfig.pro').then(() => {
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
              const clientRequest = module.get(`${protocol}://${req.query.host}`)

              clientRequest.on('error', noop)
              setImmediate(() => {
                clientRequest.destroy()
                res.end('end')
              })
            }

            await Promise.all([
              checkRaspExecutedAndNotThreat(agent),
              httpRequest.get(`/?host=${NON_ROUTABLE_HOST}`),
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

      describe('Test using fetch', () => {
        let target
        let targetRequests
        let targetAuthorizations

        before(async () => {
          // The first fetch of the process loads the fetch plugin, and RASP would count the files read then as LFI
          // evaluations of the test request.
          await fetch('not-a-real-protocol://preload').catch(noop)

          target = require('http').createServer((req, res) => {
            targetRequests++
            targetAuthorizations.push(req.headers.authorization)
            res.end('target')
          })
          await new Promise(resolve => target.listen(0, '127.0.0.1', resolve))
        })

        beforeEach(() => {
          targetRequests = 0
          targetAuthorizations = []
        })

        after(done => {
          target.closeAllConnections()
          target.close(done)
        })

        function getTargetHost () {
          return `127.0.0.1:${(/** @type {import('net').AddressInfo} */ (target.address())).port}`
        }

        async function testBlockedFetch () {
          const targetHost = getTargetHost()

          const [response] = await Promise.all([
            httpRequest.get(`/?host=${targetHost}`, { validateStatus: null }),
            checkRaspExecutedAndHasThreat(agent, 'rasp-ssrf-rule-id-1'),
          ])

          assert.strictEqual(response.status, 403)
          assert.deepStrictEqual(response.data.errors, JSON.parse(json).errors)
          assert.strictEqual(targetRequests, 0)
        }

        it('Should not detect threat', async () => {
          app = (req, res) => {
            const abortController = new AbortController()
            fetch(`http://${req.query.host}`, { signal: abortController.signal }).catch(noop)

            setImmediate(() => {
              abortController.abort()
              res.end('end')
            })
          }

          await Promise.all([
            checkRaspExecutedAndNotThreat(agent),
            httpRequest.get(`/?host=${NON_ROUTABLE_HOST}`),
          ])
        })

        it('Should block a threat doing a GET request', async () => {
          app = async (req, res, next) => {
            try {
              await fetch(`http://${req.query.host}/`)
              res.end('end')
            } catch (error) {
              next(error)
            }
          }

          await testBlockedFetch()
        })

        it('Should block a threat doing a POST request', async () => {
          app = async (req, res, next) => {
            try {
              await fetch(`http://${req.query.host}/`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ key: 'value' }),
              })
              res.end('end')
            } catch (error) {
              next(error)
            }
          }

          await testBlockedFetch()
        })

        it('Should block a threat doing a request with a Request and options', async () => {
          app = async (req, res, next) => {
            try {
              await fetch(new Request(`http://${req.query.host}/`), {
                method: 'POST',
                body: JSON.stringify({ key: 'value' }),
              })
              res.end('end')
            } catch (error) {
              next(error)
            }
          }

          await testBlockedFetch()
        })

        it('Should cancel the stream body of a blocked request', async () => {
          /** @type {Error | undefined} */
          let cancelReason
          app = async (req, res, next) => {
            const body = new ReadableStream({
              pull (controller) {
                controller.enqueue(new TextEncoder().encode('chunk'))
              },
              cancel (reason) {
                cancelReason = reason
              },
            })

            try {
              await fetch(`http://${req.query.host}/`, { method: 'POST', body, duplex: 'half' })
              res.end('end')
            } catch (error) {
              next(error)
            }
          }

          await testBlockedFetch()

          assert.strictEqual(cancelReason?.name, 'DatadogRaspAbortError')
        })

        it('Should send the headers of a one-shot iterator in the options of a Request', async () => {
          app = async (req, res) => {
            const headers = new Map([['authorization', 'Bearer token']]).entries()
            // @ts-expect-error fetch accepts any iterable of header pairs
            const response = await fetch(new Request(`http://${getTargetHost()}/`), { headers })
            res.end(await response.text())
          }

          const response = await httpRequest.get('/')

          assert.strictEqual(response.data, 'target')
          assert.deepStrictEqual(targetAuthorizations, ['Bearer token'])
        })

        it('Should keep the rejection of an invalid method in the options of a Request', async () => {
          app = async (req, res) => {
            try {
              // @ts-expect-error fetch rejects a method that can't be converted to a string
              await fetch(new Request(`http://${getTargetHost()}/`), { method: { toString: 0 } })
              res.end('resolved')
            } catch (error) {
              res.end(error.name)
            }
          }

          const response = await httpRequest.get('/')

          assert.strictEqual(response.data, 'TypeError')
          assert.strictEqual(targetRequests, 0)
        })
      })

      describe('Test using axios', () => {
        withVersions('express', 'axios', axiosVersion => {
          let axiosToTest

          before(async () => {
            axiosToTest = require(`../../../../../versions/axios@${axiosVersion}`).get()

            // Preload axios to trigger its lazily-loaded debug dependency outside of any
            // request context, which would otherwise cause a false-positive RASP LFI event.
            // We drain the resulting span synchronously within this `before` hook so it
            // cannot bleed into any test's assertion window.
            const preloadSpanDrained = agent.assertSomeTraces(noop).catch(noop)
            await Promise.all([
              axiosToTest.get('http://preloadaxios', { timeout: 10 }).catch(noop),
              preloadSpanDrained,
            ])
          })

          it('Should not detect threat', async () => {
            app = (req, res) => {
              const abortController = new AbortController()
              axiosToTest.get(`https://${req.query.host}`, { proxy: false, signal: abortController.signal })
                .catch(noop) // swallow network error

              setImmediate(() => {
                abortController.abort()
                res.end('end')
              })
            }

            await Promise.all([
              httpRequest.get(`/?host=${NON_ROUTABLE_HOST}`),
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
              const clientRequest = requestToTest.get(`https://${req.query.host}`, { proxy: false })
              clientRequest.on('error', noop)

              setImmediate(() => {
                clientRequest.abort()
                res.end('end')
              })
            }

            await Promise.all([
              httpRequest.get(`/?host=${NON_ROUTABLE_HOST}`),
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
    let app, server, httpRequest

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
        httpRequest = HttpRequest.create({
          baseURL: `http://localhost:${port}`,
        })

        done()
      })
    })

    after(() => {
      appsec.disable()
      server.close()
      return agent.close()
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

      const response = await httpRequest.get('/', {
        headers: {
          host: 'localhost/ifconfig.pro',
        },
      })

      assert.strictEqual(response.status, 200)

      return checkRaspExecutedAndHasThreat(agent, 'rasp-ssrf-rule-id-1')
    })
  })
})
