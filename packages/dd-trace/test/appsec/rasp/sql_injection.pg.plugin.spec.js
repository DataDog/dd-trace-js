'use strict'

const agent = require('../../plugins/agent')
const appsec = require('../../../src/appsec')
const Config = require('../../../src/config')
const path = require('path')
const Axios = require('axios')
const { assert } = require('chai')

describe('RASP - sql_injection', () => {
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

  withVersions('pg', 'express', expressVersion => {
    withVersions('pg', 'pg', pgVersion => {
      describe('sql injection with pg', () => {
        const connectionData = {
          host: '127.0.0.1',
          user: 'postgres',
          password: 'postgres',
          database: 'postgres',
          application_name: 'test'
        }
        let server, axios, app, pg

        before(() => {
          return agent.load(['express', 'http', 'pg'], { client: false })
        })

        before(done => {
          const express = require(`../../../../../versions/express@${expressVersion}`).get()
          pg = require(`../../../../../versions/pg@${pgVersion}`).get()
          const expressApp = express()

          expressApp.get('/', (req, res) => {
            app(req, res)
          })

          appsec.enable(new Config({
            appsec: {
              enabled: true,
              rules: path.join(__dirname, 'resources', 'rasp_rules.json'),
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

        describe('Test using pg.Client', () => {
          let client

          beforeEach((done) => {
            client = new pg.Client(connectionData)
            client.connect(err => done(err))
          })

          afterEach(() => {
            client.end()
          })

          it('Should not detect threat', async () => {
            app = (req, res) => {
              client.query('SELECT ' + req.query.param, (err) => {
                if (err) {
                  res.statusCode = 500
                }

                res.end()
              })
            }

            axios.get('/?param=1')

            await agent.use((traces) => {
              const span = getWebSpan(traces)
              assert.notProperty(span.meta, '_dd.appsec.json')
              assert.notProperty(span.meta_struct || {}, '_dd.stack')
              assert.equal(span.metrics['_dd.appsec.rasp.rule.eval'], 1)
            })
          })

          it('Should block query with callback', async () => {
            app = (req, res) => {
              client.query(`SELECT * FROM users WHERE id='${req.query.param}'`, (err) => {
                if (err?.name === 'DatadogRaspAbortError') {
                  res.statusCode = 500
                }
                res.end()
              })
            }

            try {
              await axios.get('/?param=\' OR 1 = 1 --')
            } catch (e) {
              return await agent.use((traces) => {
                const span = getWebSpan(traces)
                assert.property(span.meta, '_dd.appsec.json')
                assert(span.meta['_dd.appsec.json'].includes('rasp-sqli-rule-id-2'))
                assert.equal(span.metrics['_dd.appsec.rasp.rule.eval'], 1)
                assert(span.metrics['_dd.appsec.rasp.duration'] > 0)
                assert(span.metrics['_dd.appsec.rasp.duration_ext'] > 0)
                assert.property(span.meta_struct, '_dd.stack')
              })
            }

            assert.fail('Request should be blocked')
          })

          it('Should block query with promise', async () => {
            app = async (req, res) => {
              try {
                await client.query(`SELECT * FROM users WHERE id = '${req.query.param}'`)
              } catch (err) {
                if (err?.name === 'DatadogRaspAbortError') {
                  res.statusCode = 500
                }
                res.end()
              }
            }

            try {
              await axios.get('/?param=\' OR 1 = 1 --')
            } catch (e) {
              return await agent.use((traces) => {
                const span = getWebSpan(traces)
                assert.property(span.meta, '_dd.appsec.json')
                assert(span.meta['_dd.appsec.json'].includes('rasp-sqli-rule-id-2'))
                assert.equal(span.metrics['_dd.appsec.rasp.rule.eval'], 1)
                assert(span.metrics['_dd.appsec.rasp.duration'] > 0)
                assert(span.metrics['_dd.appsec.rasp.duration_ext'] > 0)
                assert.property(span.meta_struct, '_dd.stack')
              })
            }

            assert.fail('Request should be blocked')
          })
        })

        describe('Test using pg.Pool', () => {
          let pool

          beforeEach(() => {
            pool = new pg.Pool(connectionData)
          })

          it('Should not detect threat', async () => {
            app = (req, res) => {
              pool.query('SELECT ' + req.query.param, (err) => {
                if (err) {
                  res.statusCode = 500
                }

                res.end()
              })
            }

            axios.get('/?param=1')

            await agent.use((traces) => {
              const span = getWebSpan(traces)
              assert.notProperty(span.meta, '_dd.appsec.json')
              assert.notProperty(span.meta_struct || {}, '_dd.stack')
              assert.equal(span.metrics['_dd.appsec.rasp.rule.eval'], 1)
            })
          })

          it('Should block query with callback', async () => {
            app = (req, res) => {
              pool.query(`SELECT * FROM users WHERE id='${req.query.param}'`, (err) => {
                if (err?.name === 'DatadogRaspAbortError') {
                  res.statusCode = 500
                }
                res.end()
              })
            }

            try {
              await axios.get('/?param=\' OR 1 = 1 --')
            } catch (e) {
              return await agent.use((traces) => {
                const span = getWebSpan(traces)
                assert.property(span.meta, '_dd.appsec.json')
                assert(span.meta['_dd.appsec.json'].includes('rasp-sqli-rule-id-2'))
                assert.equal(span.metrics['_dd.appsec.rasp.rule.eval'], 1)
                assert(span.metrics['_dd.appsec.rasp.duration'] > 0)
                assert(span.metrics['_dd.appsec.rasp.duration_ext'] > 0)
                assert.property(span.meta_struct, '_dd.stack')
              })
            }

            assert.fail('Request should be blocked')
          })

          it('Should block query with promise', async () => {
            app = async (req, res) => {
              try {
                await pool.query(`SELECT * FROM users WHERE id = '${req.query.param}'`)
              } catch (err) {
                if (err?.name === 'DatadogRaspAbortError') {
                  res.statusCode = 500
                }
                res.end()
              }
            }

            try {
              await axios.get('/?param=\' OR 1 = 1 --')
            } catch (e) {
              return await agent.use((traces) => {
                const span = getWebSpan(traces)
                assert.property(span.meta, '_dd.appsec.json')
                assert(span.meta['_dd.appsec.json'].includes('rasp-sqli-rule-id-2'))
                assert.equal(span.metrics['_dd.appsec.rasp.rule.eval'], 1)
                assert(span.metrics['_dd.appsec.rasp.duration'] > 0)
                assert(span.metrics['_dd.appsec.rasp.duration_ext'] > 0)
                assert.property(span.meta_struct, '_dd.stack')
              })
            }

            assert.fail('Request should be blocked')
          })
        })
      })
    })
  })
})
