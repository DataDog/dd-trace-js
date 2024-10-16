'use strict'

const agent = require('../../plugins/agent')
const appsec = require('../../../src/appsec')
const Config = require('../../../src/config')
const path = require('path')
const Axios = require('axios')
const { getWebSpan, checkRaspExecutedAndHasThreat, checkRaspExecutedAndNotThreat } = require('./utils')
const { assert } = require('chai')

describe('RASP - command_injection', () => {
  withVersions('express', 'express', expressVersion => {
    let app, server, axios

    async function testBlockingRequest () {
      try {
        await axios.get('/?dir=$(cat /etc/passwd 1>%262 ; echo .)')
      } catch (e) {
        if (!e.response) {
          throw e
        }

        return checkRaspExecutedAndHasThreat(agent, 'rasp-command_injection-rule-id-3')
      }

      assert.fail('Request should be blocked')
    }

    function checkRaspNotExecutedAndNotThreat (agent, checkRuleEval = true) {
      return agent.use((traces) => {
        const span = getWebSpan(traces)
        assert.notProperty(span.meta, '_dd.appsec.json')
        assert.notProperty(span.meta_struct || {}, '_dd.stack')
        if (checkRuleEval) {
          assert.notProperty(span.metrics, '_dd.appsec.rasp.rule.eval')
        }
      })
    }

    function testBlockingAndSafeRequests () {
      it('should block the threat', async () => {
        await testBlockingRequest()
      })

      it('should not block safe request', async () => {
        await axios.get('/?dir=.')

        return checkRaspExecutedAndNotThreat(agent)
      })
    }

    function testSafeInNonShell () {
      it('should not block the threat', async () => {
        await axios.get('/?dir=$(cat /etc/passwd 1>%262 ; echo .)')

        return checkRaspNotExecutedAndNotThreat(agent)
      })

      it('should not block safe request', async () => {
        await axios.get('/?dir=.')

        return checkRaspNotExecutedAndNotThreat(agent)
      })
    }

    before(() => {
      return agent.load(['express', 'http', 'child_process'], { client: false })
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

    describe('exec', () => {
      describe('with callback', () => {
        beforeEach(() => {
          app = (req, res) => {
            const childProcess = require('child_process')

            childProcess.exec(`ls ${req.query.dir}`, function (e) {
              if (e?.name === 'DatadogRaspAbortError') {
                res.writeHead(500)
              }

              res.end('end')
            })
          }
        })

        testBlockingAndSafeRequests()
      })

      describe('with promise', () => {
        beforeEach(() => {
          app = async (req, res) => {
            const util = require('util')
            const exec = util.promisify(require('child_process').exec)

            try {
              await exec(`ls ${req.query.dir}`)
            } catch (e) {
              if (e.name === 'DatadogRaspAbortError') {
                res.writeHead(500)
              }
            }

            res.end('end')
          }
        })

        testBlockingAndSafeRequests()
      })

      describe('with event emitter', () => {
        beforeEach(() => {
          app = (req, res) => {
            const childProcess = require('child_process')

            const child = childProcess.exec(`ls ${req.query.dir}`)
            child.on('error', (e) => {
              if (e.name === 'DatadogRaspAbortError') {
                res.writeHead(500)
              }
            })

            child.on('close', () => {
              res.end()
            })
          }
        })

        testBlockingAndSafeRequests()
      })

      describe('execSync', () => {
        beforeEach(() => {
          app = (req, res) => {
            const childProcess = require('child_process')
            try {
              childProcess.execSync(`ls ${req.query.dir}`)
            } catch (e) {
              if (e.name === 'DatadogRaspAbortError') {
                res.writeHead(500)
              }
            }

            res.end('end')
          }
        })

        testBlockingAndSafeRequests()
      })
    })

    describe('execFile', () => {
      // requires new libddwaf with support for array
      describe('with shell: true', () => {
        describe('with callback', () => {
          beforeEach(() => {
            app = (req, res) => {
              const childProcess = require('child_process')

              childProcess.execFile('ls', [req.query.dir], { shell: true }, function (e) {
                if (e?.name === 'DatadogRaspAbortError') {
                  res.writeHead(500)
                }

                res.end('end')
              })
            }
          })

          testBlockingAndSafeRequests()
        })

        describe('with promise', () => {
          beforeEach(() => {
            app = async (req, res) => {
              const util = require('util')
              const execFile = util.promisify(require('child_process').execFile)

              try {
                await execFile('ls', [req.query.dir], { shell: true })
              } catch (e) {
                if (e.name === 'DatadogRaspAbortError') {
                  res.writeHead(500)
                }
              }

              res.end('end')
            }
          })

          testBlockingAndSafeRequests()
        })

        describe('with event emitter', () => {
          beforeEach(() => {
            app = (req, res) => {
              const childProcess = require('child_process')

              const child = childProcess.execFile('ls', [req.query.dir], { shell: true })
              child.on('error', (e) => {
                if (e.name === 'DatadogRaspAbortError') {
                  res.writeHead(500)
                }
              })

              child.on('close', () => {
                res.end()
              })
            }
          })

          testBlockingAndSafeRequests()
        })

        describe('execFileSync', () => {
          beforeEach(() => {
            app = (req, res) => {
              const childProcess = require('child_process')

              try {
                childProcess.execFileSync('ls', [req.query.dir], { shell: true })
              } catch (e) {
                if (e.name === 'DatadogRaspAbortError') {
                  res.writeHead(500)
                }
              }

              res.end()
            }
          })

          testBlockingAndSafeRequests()
        })
      })

      describe('without shell', () => {
        describe('with callback', () => {
          beforeEach(() => {
            app = (req, res) => {
              const childProcess = require('child_process')

              childProcess.execFile('ls', [req.query.dir], function (e) {
                if (e?.name === 'DatadogRaspAbortError') {
                  res.writeHead(500)
                }

                res.end('end')
              })
            }
          })

          testSafeInNonShell()
        })

        describe('with promise', () => {
          beforeEach(() => {
            app = async (req, res) => {
              const util = require('util')
              const execFile = util.promisify(require('child_process').execFile)

              try {
                await execFile('ls', [req.query.dir])
              } catch (e) {
                if (e.name === 'DatadogRaspAbortError') {
                  res.writeHead(500)
                }
              }

              res.end('end')
            }
          })

          testSafeInNonShell()
        })

        describe('with event emitter', () => {
          beforeEach(() => {
            app = (req, res) => {
              const childProcess = require('child_process')

              const child = childProcess.execFile('ls', [req.query.dir])
              child.on('error', (e) => {
                if (e.name === 'DatadogRaspAbortError') {
                  res.writeHead(500)
                }
              })

              child.on('close', () => {
                res.end()
              })
            }
          })

          testSafeInNonShell()
        })

        describe('execFileSync', () => {
          beforeEach(() => {
            app = (req, res) => {
              const childProcess = require('child_process')

              try {
                childProcess.execFileSync('ls', [req.query.dir])
              } catch (e) {
                if (e.name === 'DatadogRaspAbortError') {
                  res.writeHead(500)
                }
              }

              res.end()
            }
          })

          testSafeInNonShell()
        })
      })
    })

    describe('spawn', () => {
      // requires new libddwaf with support for array
      describe('with shell: true', () => {
        describe('with event emitter', () => {
          beforeEach(() => {
            app = (req, res) => {
              const childProcess = require('child_process')

              const child = childProcess.spawn('ls', [req.query.dir], { shell: true })
              child.on('error', (e) => {
                if (e.name === 'DatadogRaspAbortError') {
                  res.writeHead(500)
                }
              })

              child.on('close', () => {
                res.end()
              })
            }
          })

          testBlockingAndSafeRequests()
        })

        describe('spawnSync', () => {
          beforeEach(() => {
            app = (req, res) => {
              const childProcess = require('child_process')

              const child = childProcess.spawnSync('ls', [req.query.dir], { shell: true })
              if (child.error?.name === 'DatadogRaspAbortError') {
                res.writeHead(500)
              }

              res.end()
            }
          })

          testBlockingAndSafeRequests()
        })
      })

      describe('without shell', () => {
        describe('with event emitter', () => {
          beforeEach(() => {
            app = (req, res) => {
              const childProcess = require('child_process')

              const child = childProcess.spawn('ls', [req.query.dir])
              child.on('error', (e) => {
                if (e.name === 'DatadogRaspAbortError') {
                  res.writeHead(500)
                }
              })

              child.on('close', () => {
                res.end()
              })
            }
          })

          testSafeInNonShell()
        })

        describe('spawnSync', () => {
          beforeEach(() => {
            app = (req, res) => {
              const childProcess = require('child_process')

              const child = childProcess.spawnSync('ls', [req.query.dir])
              if (child.error?.name === 'DatadogRaspAbortError') {
                res.writeHead(500)
              }

              res.end()
            }
          })

          testSafeInNonShell()
        })
      })
    })
  })
})
