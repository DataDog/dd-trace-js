'use strict'

const agent = require('../../plugins/agent')
const appsec = require('../../../src/appsec')
const { wafRunFinished } = require('../../../src/appsec/channels')
const addresses = require('../../../src/appsec/addresses')
const Config = require('../../../src/config')
const { withVersions } = require('../../setup/mocha')
const path = require('path')
const Axios = require('axios')
const { assert } = require('chai')
const { checkRaspExecutedAndNotThreat, checkRaspExecutedAndHasThreat } = require('./utils')

describe('RASP - sql_injection', () => {
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

            await checkRaspExecutedAndNotThreat(agent)
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
              return await checkRaspExecutedAndHasThreat(agent, 'rasp-sqli-rule-id-2')
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
              return checkRaspExecutedAndHasThreat(agent, 'rasp-sqli-rule-id-2')
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

            await checkRaspExecutedAndNotThreat(agent)
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
              return checkRaspExecutedAndHasThreat(agent, 'rasp-sqli-rule-id-2')
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
              return checkRaspExecutedAndHasThreat(agent, 'rasp-sqli-rule-id-2')
            }

            assert.fail('Request should be blocked')
          })

          describe('double calls', () => {
            const WAFContextWrapper = require('../../../src/appsec/waf/waf_context_wrapper')
            let run

            beforeEach(() => {
              run = sinon.spy(WAFContextWrapper.prototype, 'run')
            })

            afterEach(() => {
              sinon.restore()
            })

            async function runQueryAndIgnoreError (query) {
              try {
                await pool.query(query)
              } catch (err) {
                // do nothing
              }
            }

            it('should call to waf only once for sql injection using pg Pool', async () => {
              app = async (req, res) => {
                await runQueryAndIgnoreError('SELECT 1')
                res.end()
              }

              await axios.get('/')

              assert.equal(run.args.filter(arg => arg[1]?.type === 'sql_injection').length, 1)
            })

            it('should call to waf twice for sql injection with two different queries in pg Pool', async () => {
              app = async (req, res) => {
                await runQueryAndIgnoreError('SELECT 1')
                await runQueryAndIgnoreError('SELECT 2')

                res.end()
              }

              await axios.get('/')

              assert.equal(run.args.filter(arg => arg[1]?.type === 'sql_injection').length, 2)
            })

            it('should call to waf twice for sql injection and same query when input address is updated', async () => {
              app = async (req, res) => {
                await runQueryAndIgnoreError('SELECT 1')

                wafRunFinished.publish({
                  payload: {
                    persistent: {
                      [addresses.HTTP_INCOMING_URL]: 'test'
                    }
                  }
                })

                await runQueryAndIgnoreError('SELECT 1')

                res.end()
              }

              await axios.get('/')

              assert.equal(run.args.filter(arg => arg[1]?.type === 'sql_injection').length, 2)
            })

            it('should call to waf once for sql injection and same query when input address is updated', async () => {
              app = async (req, res) => {
                await runQueryAndIgnoreError('SELECT 1')

                wafRunFinished.publish({
                  payload: {
                    persistent: {
                      'not-an-input': 'test'
                    }
                  }
                })

                await runQueryAndIgnoreError('SELECT 1')

                res.end()
              }

              await axios.get('/')

              assert.equal(run.args.filter(arg => arg[1]?.type === 'sql_injection').length, 1)
            })
          })
        })
      })
    })
  })
})
