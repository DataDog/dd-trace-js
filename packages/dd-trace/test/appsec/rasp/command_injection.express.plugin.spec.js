'use strict'

const agent = require('../../plugins/agent')
const appsec = require('../../../src/appsec')
const Config = require('../../../src/config')
const { withVersions } = require('../../setup/mocha')
const path = require('path')
const Axios = require('axios')
const { checkRaspExecutedAndHasThreat, checkRaspExecutedAndNotThreat } = require('./utils')
const { assert } = require('chai')

describe('RASP - command_injection', () => {
  withVersions('express', 'express', expressVersion => {
    let app, server, axios
    function testShellBlockingAndSafeRequests () {
      it('should block the threat', async () => {
        try {
          await axios.get('/?dir=$(cat /etc/passwd 1>%262 ; echo .)')
        } catch (e) {
          if (!e.response) {
            throw e
          }

          return checkRaspExecutedAndHasThreat(agent, 'rasp-command_injection-rule-id-3')
        }

        assert.fail('Request should be blocked')
      })

      it('should not block safe request', async () => {
        await axios.get('/?dir=.')

        return checkRaspExecutedAndNotThreat(agent)
      })
    }

    function testNonShellBlockingAndSafeRequests () {
      it('should block the threat', async () => {
        try {
          await axios.get('/?command=/usr/bin/reboot')
        } catch (e) {
          if (!e.response) {
            throw e
          }

          return checkRaspExecutedAndHasThreat(agent, 'rasp-command_injection-rule-id-4')
        }

        assert.fail('Request should be blocked')
      })

      it('should not block safe request', async () => {
        await axios.get('/?command=.')

        return checkRaspExecutedAndNotThreat(agent)
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

        testShellBlockingAndSafeRequests()
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

        testShellBlockingAndSafeRequests()
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

        testShellBlockingAndSafeRequests()
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

        testShellBlockingAndSafeRequests()
      })
    })

    describe('execFile', () => {
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

          testShellBlockingAndSafeRequests()
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

          testShellBlockingAndSafeRequests()
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

          testShellBlockingAndSafeRequests()
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

          testShellBlockingAndSafeRequests()
        })
      })

      describe('without shell', () => {
        describe('with callback', () => {
          beforeEach(() => {
            app = (req, res) => {
              const childProcess = require('child_process')

              childProcess.execFile(req.query.command, function (e) {
                if (e?.name === 'DatadogRaspAbortError') {
                  res.writeHead(500)
                }

                res.end('end')
              })
            }
          })

          testNonShellBlockingAndSafeRequests()
        })

        describe('with promise', () => {
          beforeEach(() => {
            app = async (req, res) => {
              const util = require('util')
              const execFile = util.promisify(require('child_process').execFile)

              try {
                await execFile([req.query.command])
              } catch (e) {
                if (e.name === 'DatadogRaspAbortError') {
                  res.writeHead(500)
                }
              }

              res.end('end')
            }
          })

          testNonShellBlockingAndSafeRequests()
        })

        describe('with event emitter', () => {
          beforeEach(() => {
            app = (req, res) => {
              const childProcess = require('child_process')
              const child = childProcess.execFile(req.query.command)
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

          testNonShellBlockingAndSafeRequests()
        })

        describe('execFileSync', () => {
          beforeEach(() => {
            app = (req, res) => {
              const childProcess = require('child_process')

              try {
                childProcess.execFileSync([req.query.command])
              } catch (e) {
                if (e.name === 'DatadogRaspAbortError') {
                  res.writeHead(500)
                }
              }

              res.end()
            }
          })

          testNonShellBlockingAndSafeRequests()
        })
      })
    })

    describe('spawn', () => {
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

          testShellBlockingAndSafeRequests()
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

          testShellBlockingAndSafeRequests()
        })
      })

      describe('without shell', () => {
        describe('with event emitter', () => {
          beforeEach(() => {
            app = (req, res) => {
              const childProcess = require('child_process')

              const child = childProcess.spawn(req.query.command)
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

          testNonShellBlockingAndSafeRequests()
        })

        describe('spawnSync', () => {
          beforeEach(() => {
            app = (req, res) => {
              const childProcess = require('child_process')

              const child = childProcess.spawnSync(req.query.command)
              if (child.error?.name === 'DatadogRaspAbortError') {
                res.writeHead(500)
              }

              res.end()
            }
          })

          testNonShellBlockingAndSafeRequests()
        })
      })
    })
  })
})
