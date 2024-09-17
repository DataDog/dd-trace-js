'use strict'

const Axios = require('axios')
const agent = require('../../plugins/agent')
const appsec = require('../../../src/appsec')
const Config = require('../../../src/config')
const path = require('path')
const { assert } = require('chai')
const { checkRaspExecutedAndNotThreat, checkRaspExecutedAndHasThreat } = require('./utils')

describe('RASP - lfi', () => {
  let axios

  async function testBlockingRequest (url = '/?file=/test.file', config = undefined) {
    try {
      await axios.get(url, config)
    } catch (e) {
      if (!e.response) {
        throw e
      }

      assert.strictEqual(e.response.status, 418) // a teapot

      return checkRaspExecutedAndHasThreat(agent, 'rasp-lfi-rule-id-1')
    }

    assert.fail('Request should be blocked')
  }

  withVersions('express', 'express', expressVersion => {
    let app, server

    before(() => {
      return agent.load(['http', 'express'], { client: false })
    })

    before((done) => {
      const express = require(`../../../../../versions/express@${expressVersion}`).get()
      const expressApp = express()

      expressApp.get('/', (req, res) => {
        app(req, res)
      })

      appsec.enable(new Config({
        appsec: {
          enabled: true,
          rules: path.join(__dirname, 'resources', 'lfi_rasp_rules.json'),
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

    describe('lfi', () => {
      describe('fs sync', () => {
        it('Should not detect threat', async () => {
          app = (req, res) => {
            try {
              require('fs').statSync(req.query.file)
            } catch (e) {
              if (e.message === 'DatadogRaspAbortError') {
                res.writeHead(418)
              }
            }
            res.end('end')
          }

          await axios.get('/?file=./test.file')

          return checkRaspExecutedAndNotThreat(agent, false)
        })

        it('Should not detect threat using a path not present in the request', async () => {
          app = (req, res) => {
            try {
              require('fs').statSync('/test.file')
            } catch (e) {
              if (e.message === 'DatadogRaspAbortError') {
                res.writeHead(418)
              }
            }
            res.end('end')
          }

          await axios.get('/')

          return checkRaspExecutedAndNotThreat(agent)
        })

        it('Should detect threat using a sync method', async () => {
          app = (req, res) => {
            try {
              require('fs').statSync(req.query.file)
            } catch (e) {
              if (e.message === 'DatadogRaspAbortError') {
                res.writeHead(418)
              }
            }
            res.end('end')
          }

          return testBlockingRequest()
        })

        it('Should detect threat using fs.promises', async () => {
          app = async (req, res) => {
            try {
              await require('fs').promises.stat(req.query.file)
            } catch (e) {
              if (e.message === 'DatadogRaspAbortError') {
                res.writeHead(418)
              }
            }
            res.end('end')
          }

          return testBlockingRequest()
        })

        it('Should detect threat using callback', async () => {
          app = (req, res) => {
            require('fs').stat(req.query.file, (e) => {
              if (e.message === 'DatadogRaspAbortError') {
                res.writeHead(418)
              }
            })
            res.end('end')
          }

          return testBlockingRequest()
        })

        it('Should detect threat using callback in ops with multiple paths', async () => {
          app = (req, res) => {
            require('fs').cp(req.query.file, './test.file.tmp', (e) => {
              if (e.message === 'DatadogRaspAbortError') {
                res.writeHead(418)
              }
            })
            res.end('end')
          }

          return testBlockingRequest()
        })
      })
    })
  })

  describe('without express', () => {
    let app, server

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

      appsec.enable(new Config({
        appsec: {
          enabled: true,
          rules: path.join(__dirname, 'resources', 'lfi_rasp_rules.json'),
          rasp: { enabled: true }
        }
      }))

      server.listen(0, () => {
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

    it('Should detect threat but not block', async () => {
      app = (req, res) => {
        try {
          require('fs').statSync(req.headers.file)
        } catch (e) {
          if (e.message === 'DatadogRaspAbortError') {
            res.writeHead(500)
          } else {
            res.writeHead(418)
          }
        }
        res.end('end')
      }

      return testBlockingRequest('/', {
        headers: {
          file: '/test.file'
        }
      })
    })
  })
})
