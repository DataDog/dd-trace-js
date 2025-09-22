'use strict'

const agent = require('../../plugins/agent')
const appsec = require('../../../src/appsec')
const Config = require('../../../src/config')
const { withVersions } = require('../../setup/mocha')
const path = require('path')
const Axios = require('axios')
const { assert } = require('chai')
const { checkRaspExecutedAndNotThreat, checkRaspExecutedAndHasThreat } = require('./utils')

describe('RASP - sql_injection', () => {
  withVersions('mysql2', 'express', expressVersion => {
    withVersions('mysql2', 'mysql2', mysql2Version => {
      describe('sql injection with mysql2', () => {
        const connectionData = {
          host: '127.0.0.1',
          user: 'root',
          database: 'db'
        }
        let server, axios, app, mysql2

        before(() => {
          return agent.load(['express', 'http', 'mysql2'], { client: false })
        })

        before(done => {
          const express = require(`../../../../../versions/express@${expressVersion}`).get()
          mysql2 = require(`../../../../../versions/mysql2@${mysql2Version}`).get()
          const expressApp = express()

          expressApp.get('/', (req, res) => {
            app(req, res)
          })

          appsec.enable(new Config({
            appsec: {
              enabled: true,
              rules: path.join(__dirname, 'resources', 'rasp-rules.json'),
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

        describe('Test using Connection', () => {
          let connection

          beforeEach(() => {
            connection = mysql2.createConnection(connectionData)
            connection.connect()
          })

          afterEach((done) => {
            connection.end(() => done())
          })

          describe('query', () => {
            it('Should not detect threat', async () => {
              app = (req, res) => {
                connection.query('SELECT ' + req.query.param, (err) => {
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
                connection.query(`SELECT * FROM users WHERE id='${req.query.param}'`, (err) => {
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
          })

          describe('execute', () => {
            it('Should not detect threat', async () => {
              app = (req, res) => {
                connection.execute('SELECT ' + req.query.param, (err) => {
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
                connection.execute(`SELECT * FROM users WHERE id='${req.query.param}'`, (err) => {
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
          })
        })

        describe('Test using Pool', () => {
          let pool

          beforeEach(() => {
            pool = mysql2.createPool(connectionData)
          })

          describe('query', () => {
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
                return await checkRaspExecutedAndHasThreat(agent, 'rasp-sqli-rule-id-2')
              }

              assert.fail('Request should be blocked')
            })
          })

          describe('execute', () => {
            it('Should not detect threat', async () => {
              app = (req, res) => {
                pool.execute('SELECT ' + req.query.param, (err) => {
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
                pool.execute(`SELECT * FROM users WHERE id='${req.query.param}'`, (err) => {
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
          })
        })
      })
    })
  })
})
