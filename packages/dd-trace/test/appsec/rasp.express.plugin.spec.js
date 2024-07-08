'use strict'

const Axios = require('axios')
const agent = require('../plugins/agent')
const appsec = require('../../src/appsec')
const Config = require('../../src/config')
const path = require('path')
const { assert } = require('chai')

function noop () {}

withVersions('express', 'express', expressVersion => {
  describe('RASP', () => {
    let app, server, axios

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

      server = expressApp.listen(0, () => {
        const port = server.address().port
        axios = Axios.create({
          baseURL: `http://localhost:${port}`
        })
        done()
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
      ['http', 'https'].forEach(protocol => {
        describe(`Test using ${protocol}`, () => {
          it('Should not detect threat', async () => {
            app = (req, res) => {
              const clientRequest = require(protocol).get(`${protocol}://${req.query.host}`)
              clientRequest.on('error', noop)
              res.end('end')
            }

            axios.get('/?host=www.datadoghq.com')

            await agent.use((traces) => {
              const span = getWebSpan(traces)
              assert.notProperty(span.meta, '_dd.appsec.json')
              assert.notProperty(span.meta_struct || {}, '_dd.stack')
            })
          })

          it('Should detect threat doing a GET request', async () => {
            app = (req, res) => {
              const clientRequest = require(protocol).get(`${protocol}://${req.query.host}`)
              clientRequest.on('error', noop)
              res.end('end')
            }

            axios.get('/?host=localhost/ifconfig.pro')

            await agent.use((traces) => {
              const span = getWebSpan(traces)
              assert.property(span.meta, '_dd.appsec.json')
              assert(span.meta['_dd.appsec.json'].includes('rasp-ssrf-rule-id-1'))
              assert.equal(span.metrics['_dd.appsec.rasp.rule.eval'], 1)
              assert(span.metrics['_dd.appsec.rasp.duration'] > 0)
              assert(span.metrics['_dd.appsec.rasp.duration_ext'] > 0)
              assert.property(span.meta_struct, '_dd.stack')
            })
          })

          it('Should detect threat doing a POST request', async () => {
            app = (req, res) => {
              const clientRequest = require(protocol)
                .request(`${protocol}://${req.query.host}`, { method: 'POST' })
              clientRequest.on('error', noop)
              clientRequest.write('dummy_post_data')
              clientRequest.end()
              res.end('end')
            }

            axios.get('/?host=localhost/ifconfig.pro')

            await agent.use((traces) => {
              const span = getWebSpan(traces)
              assert.property(span.meta, '_dd.appsec.json')
              assert(span.meta['_dd.appsec.json'].includes('rasp-ssrf-rule-id-1'))
              assert.equal(span.metrics['_dd.appsec.rasp.rule.eval'], 1)
              assert(span.metrics['_dd.appsec.rasp.duration'] > 0)
              assert(span.metrics['_dd.appsec.rasp.duration_ext'] > 0)
              assert.property(span.meta_struct, '_dd.stack')
            })
          })
        })
      })
    })
  })
})
