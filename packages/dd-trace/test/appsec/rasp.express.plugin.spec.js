'use strict'

const Axios = require('axios')
const agent = require('../plugins/agent')
const getPort = require('get-port')
const appsec = require('../../src/appsec')
const Config = require('../../src/config')
const path = require('path')
const { assert } = require('chai')

withVersions('express', 'express', expressVersion => {
  describe('RASP', () => {
    let app, server, port, axios

    before(() => {
      return agent.load(['http'], { client: false })
    })

    before((done) => {
      const express = require(`../../../../versions/express@${expressVersion}`).get()
      const expressApp = express()

      expressApp.get('/', (req, res) => {
        app(req, res)
      })

      appsec.enable(new Config({
        appsec: {
          enabled: true,
          rules: path.join(__dirname, 'rasp_rules.json'),
          rasp: { enabled: true }
        }
      }))

      getPort().then(newPort => {
        port = newPort
        axios = Axios.create({
          baseURL: `http://localhost:${port}`
        })
        server = expressApp.listen(port, () => {
          done()
        })
      })
    })

    after(() => {
      appsec.disable()
      server.close()
      return agent.close({ ritmReset: false })
    })

    function getWebSpan (traces) {
      for (const trace of traces) {
        for (const span of trace) {
          if (span.type === 'web') {
            return span
          }
        }
      }
      throw new Error('web span not found')
    }

    describe('ssrf', () => {
      async function testBlockingRequest () {
        try {
          await axios.get('/?host=ifconfig.pro')
          assert.fail('Request should be blocked')
        } catch (e) {
          if (!e.response) {
            throw e
          }
        }

        await agent.use((traces) => {
          const span = getWebSpan(traces)
          assert.property(span.meta, '_dd.appsec.json')
          assert(span.meta['_dd.appsec.json'].includes('rasp-ssrf-rule-id-1'))
          assert.equal(span.metrics['_dd.appsec.rasp.rule.eval'], 1)
          assert(span.metrics['_dd.appsec.rasp.duration'] > 0)
          assert(span.metrics['_dd.appsec.rasp.duration_ext'] > 0)
        })
      }

      ['http', 'https'].forEach(protocol => {
        describe(`Test using ${protocol}`, () => {
          it('Should not detect threat', async () => {
            app = (req, res) => {
              require(protocol).get(`${protocol}://${req.query.host}`)
              res.end('end')
            }

            axios.get('/?host=www.datadoghq.com')

            await agent.use((traces) => {
              const span = getWebSpan(traces)
              assert.notProperty(span.meta, '_dd.appsec.json')
            })
          })

          it('Should detect threat doing a GET request', async () => {
            app = (req, res) => {
              const clientRequest = require(protocol).get(`${protocol}://${req.query.host}`)
              clientRequest.on('error', (e) => {
                if (e.message === 'AbortError') {
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
                if (e.message === 'AbortError') {
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

          beforeEach(() => {
            axiosToTest = require(`../../../../versions/axios@${axiosVersion}`).get()
          })

          it('Should not detect threat', async () => {
            app = (req, res) => {
              axios.get(`https://${req.query.host}`)
              res.end('end')
            }

            axios.get('/?host=www.datadoghq.com')

            await agent.use((traces) => {
              const span = getWebSpan(traces)
              assert.notProperty(span.meta, '_dd.appsec.json')
            })
          })

          it('Should detect threat doing a GET request', async () => {
            app = async (req, res) => {
              try {
                await axiosToTest.get(`https://${req.query.host}`)
                res.end('end')
              } catch (e) {
                if (e.cause.message === 'AbortError') {
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
                await axios.post(`https://${req.query.host}`, { key: 'value' })
              } catch (e) {
                if (e.cause.message === 'AbortError') {
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
})
