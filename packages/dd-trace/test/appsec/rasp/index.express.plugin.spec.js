'use strict'

const axios = require('axios')
const agent = require('../../plugins/agent')
const getPort = require('get-port')
const appsec = require('../../../src/appsec')
const Config = require('../../../src/config')
const path = require('path')
const { assert } = require('chai')

withVersions('express', 'express', expressVersion => {
  describe('RASP', () => {
    let app, server, port

    before(() => {
      return agent.load(['http'], { client: false })
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
          rules: path.join(__dirname, 'rasp_rules.json'),
          rasp: { enabled: true }
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
      ['http', 'https'].forEach(protocol => {
        describe(`Test using ${protocol}`, () => {
          it('Should not detect threat', async () => {
            app = (req, res) => {
              require(protocol).get(`${protocol}://${req.query.host}`)
              res.end('end')
            }

            axios.get(`http://localhost:${port}/?host=www.datadoghq.com`)

            await agent.use((traces) => {
              const span = getWebSpan(traces)
              assert.notProperty(span.meta, '_dd.appsec.json')
            })
          })

          it('Should detect threat doing a GET request', async () => {
            app = (req, res) => {
              require(protocol).get(`${protocol}://${req.query.host}`)
              res.end('end')
            }

            axios.get(`http://localhost:${port}/?host=ifconfig.pro`)

            await agent.use((traces) => {
              const span = getWebSpan(traces)
              assert.property(span.meta, '_dd.appsec.json')
              assert(span.meta['_dd.appsec.json'].includes('rasp-ssrf-rule-id-1'))
            })
          }).timeout(3000)

          it('Should detect threat doing a POST request', async () => {
            app = (req, res) => {
              const clientRequest = require(protocol)
                .request(`${protocol}://${req.query.host}`, { method: 'POST' })
              clientRequest.write('dummy_post_data')
              clientRequest.end()
              res.end('end')
            }

            axios.get(`http://localhost:${port}/?host=ifconfig.pro`)

            await agent.use((traces) => {
              const span = getWebSpan(traces)
              assert.property(span.meta, '_dd.appsec.json')
              assert(span.meta['_dd.appsec.json'].includes('rasp-ssrf-rule-id-1'))
            })
          })
        })
      })
    })
  })
})
