'use strict'

const getPort = require('get-port')
const path = require('path')
const Axios = require('axios')
const { assert } = require('chai')
const { createSandbox, FakeAgent, spawnProc } = require('../helpers')

describe('RASP', () => {
  let axios, sandbox, cwd, appPort, appFile, agent, proc, stdioHandler

  function stdOutputHandler (data) {
    stdioHandler && stdioHandler(data)
  }

  before(async () => {
    sandbox = await createSandbox(['express', 'axios'])
    appPort = await getPort()
    cwd = sandbox.folder
    appFile = path.join(cwd, 'appsec/rasp/index.js')
    axios = Axios.create({
      baseURL: `http://localhost:${appPort}`
    })
  })

  after(async () => {
    await sandbox.remove()
  })

  function startServer (abortOnUncaughtException) {
    beforeEach(async () => {
      let execArgv = process.execArgv
      if (abortOnUncaughtException) {
        execArgv = ['--abort-on-uncaught-exception', ...execArgv]
      }
      agent = await new FakeAgent().start()
      proc = await spawnProc(appFile, {
        cwd,
        execArgv,
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
          APP_PORT: appPort,
          DD_APPSEC_ENABLED: true,
          DD_APPSEC_RASP_ENABLED: true,
          DD_APPSEC_RULES: path.join(cwd, 'appsec/rasp/rasp_rules.json')
        }
      }, stdOutputHandler, stdOutputHandler)
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })
  }

  async function assertExploitDetected () {
    await agent.assertMessageReceived(({ headers, payload }) => {
      assert.property(payload[0][0].meta, '_dd.appsec.json')
      assert.include(payload[0][0].meta['_dd.appsec.json'], '"test-rule-id-2"')
    })
  }

  describe('--abort-on-uncaught-exception is not configured', () => {
    startServer(false)

    async function testNotCrashedAfterBlocking (path) {
      let hasOutput = false
      stdioHandler = () => {
        hasOutput = true
      }

      try {
        await axios.get(`${path}?host=localhost/ifconfig.pro`)

        assert.fail('Request should have failed')
      } catch (e) {
        if (!e.response) {
          throw e
        }

        assert.strictEqual(e.response.status, 403)
        await assertExploitDetected()
      }

      return new Promise((resolve, reject) => {
        setTimeout(() => {
          if (hasOutput) {
            reject(new Error('Unexpected output in stdout/stderr after blocking request'))
          } else {
            resolve()
          }
        }, 50)
      })
    }

    async function testCustomErrorHandlerIsNotExecuted (path) {
      let hasOutput = false
      try {
        stdioHandler = () => {
          hasOutput = true
        }

        await axios.get(`${path}?host=localhost/ifconfig.pro`)

        assert.fail('Request should have failed')
      } catch (e) {
        if (!e.response) {
          throw e
        }

        assert.strictEqual(e.response.status, 403)
        await assertExploitDetected()

        return new Promise((resolve, reject) => {
          setTimeout(() => {
            if (hasOutput) {
              reject(new Error('uncaughtExceptionCaptureCallback executed'))
            } else {
              resolve()
            }
          }, 10)
        })
      }
    }

    async function testAppCrashesAsExpected () {
      let hasOutput = false
      stdioHandler = () => {
        hasOutput = true
      }

      try {
        await axios.get('/crash')
      } catch (e) {
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            if (hasOutput) {
              resolve()
            } else {
              reject(new Error('Output expected after crash'))
            }
          }, 50)
        })
      }

      assert.fail('Request should have failed')
    }

    describe('ssrf', () => {
      it('should crash when error is not an AbortError', async () => {
        await testAppCrashesAsExpected()
      })

      it('should not crash when customer has his own setUncaughtExceptionCaptureCallback', async () => {
        let hasOutput = false
        stdioHandler = () => {
          hasOutput = true
        }

        try {
          await axios.get('/crash-and-recovery-A')
        } catch (e) {
          return new Promise((resolve, reject) => {
            setTimeout(() => {
              if (hasOutput) {
                reject(new Error('Unexpected output in stdout/stderr after blocking request'))
              } else {
                resolve()
              }
            }, 50)
          })
        }

        assert.fail('Request should have failed')
      })

      it('should not crash when customer has his own uncaughtException', async () => {
        let hasOutput = false
        stdioHandler = () => {
          hasOutput = true
        }

        try {
          await axios.get('/crash-and-recovery-B')
        } catch (e) {
          return new Promise((resolve, reject) => {
            setTimeout(() => {
              if (hasOutput) {
                reject(new Error('Unexpected output in stdout/stderr after blocking request'))
              } else {
                resolve()
              }
            }, 50)
          })
        }

        assert.fail('Request should have failed')
      })

      it('should block manually', async () => {
        let response

        try {
          response = await axios.get('/ssrf/http/manual-blocking?host=localhost/ifconfig.pro')
        } catch (e) {
          if (!e.response) {
            throw e
          }
          response = e.response
          assert.strictEqual(response.status, 418)
          return await assertExploitDetected()
        }

        assert.fail('Request should have failed')
      })

      it('should block in a domain', async () => {
        let response

        try {
          response = await axios.get('/ssrf/http/should-block-in-domain?host=localhost/ifconfig.pro')
        } catch (e) {
          if (!e.response) {
            throw e
          }
          response = e.response
          assert.strictEqual(response.status, 403)
          return await assertExploitDetected()
        }

        assert.fail('Request should have failed')
      })

      it('should crash as expected after block in domain request', async () => {
        try {
          await axios.get('/ssrf/http/should-block-in-domain?host=localhost/ifconfig.pro')
        } catch (e) {
          return await testAppCrashesAsExpected()
        }

        assert.fail('Request should have failed')
      })

      it('should block when error is unhandled', async () => {
        try {
          await axios.get('/ssrf/http/unhandled-error?host=localhost/ifconfig.pro')
        } catch (e) {
          if (!e.response) {
            throw e
          }

          assert.strictEqual(e.response.status, 403)
          return await assertExploitDetected()
        }

        assert.fail('Request should have failed')
      })

      it('should crash as expected after a requiest block when error is unhandled', async () => {
        try {
          await axios.get('/ssrf/http/unhandled-error?host=localhost/ifconfig.pro')
        } catch (e) {
          return await testAppCrashesAsExpected()
        }

        assert.fail('Request should have failed')
      })

      it('should not execute custom uncaughtExceptionCaptureCallback when it is blocked', async () => {
        return testCustomErrorHandlerIsNotExecuted('/ssrf/http/custom-uncaught-exception-capture-callback')
      })

      it('should not execute custom uncaughtException listener', async () => {
        return testCustomErrorHandlerIsNotExecuted('/ssrf/http/custom-uncaughtException-listener')
      })

      it('should not crash when app send data after blocking', () => {
        return testNotCrashedAfterBlocking('/ssrf/http/unhandled-async-write-A')
      })

      it('should not crash when app stream data after blocking', () => {
        return testNotCrashedAfterBlocking('/ssrf/http/unhandled-async-write-B')
      })

      it('should not crash when setHeader, writeHead or end after blocking', () => {
        return testNotCrashedAfterBlocking('/ssrf/http/unhandled-async-write-C')
      })

      it('should not crash when appendHeader, flushHeaders, removeHeader after blocking', () => {
        return testNotCrashedAfterBlocking('/ssrf/http/unhandled-async-write-D')
      })

      it('should not crash when writeContinue after blocking', () => {
        return testNotCrashedAfterBlocking('/ssrf/http/unhandled-async-write-E')
      })

      it('should not crash when writeProcessing after blocking', () => {
        return testNotCrashedAfterBlocking('/ssrf/http/unhandled-async-write-F')
      })

      it('should not crash when writeEarlyHints after blocking', () => {
        return testNotCrashedAfterBlocking('/ssrf/http/unhandled-async-write-G')
      })

      it('should not crash when res.json after blocking', () => {
        return testNotCrashedAfterBlocking('/ssrf/http/unhandled-async-write-H')
      })

      it('should not crash when is blocked using axios', () => {
        return testNotCrashedAfterBlocking('/ssrf/http/unhandled-axios')
      })

      it('should not crash when is blocked with unhandled rejection', () => {
        return testNotCrashedAfterBlocking('/ssrf/http/unhandled-promise')
      })
    })
  })

  describe('--abort-on-uncaught-exception is configured', () => {
    startServer(true)

    describe('ssrf', () => {
      it('should not block', async () => {
        let response

        try {
          response = await axios.get('/ssrf/http/manual-blocking?host=localhost/ifconfig.pro')
        } catch (e) {
          if (!e.response) {
            throw e
          }
          response = e.response
        }

        // not blocked
        assert.notEqual(response.status, 418)
        assert.notEqual(response.status, 403)
        await assertExploitDetected()
      })
    })
  })
})
