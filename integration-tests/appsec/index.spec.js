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
    sandbox = await createSandbox(['express'])
    appPort = await getPort()
    cwd = sandbox.folder
    appFile = path.join(cwd, 'appsec/rasp/index.js')
    axios = Axios.create({
      baseURL: `http://localhost:${appPort}`
    })
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()
    proc = await spawnProc(appFile, {
      cwd,
      env: {
        AGENT_PORT: agent.port,
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

  after(async () => {
    await sandbox.remove()
  })

  async function testNotCrashedAfterBlocking (path) {
    let hasOutput = false
    stdioHandler = () => {
      hasOutput = true
    }

    try {
      await axios.get(`${path}?host=ifconfig.pro`)

      assert.fail('Request should have failed')
    } catch (e) {
      if (!e.response) {
        throw e
      }

      assert.strictEqual(e.response.status, 403)
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

  describe('ssrf', () => {
    it('should block when error is unhandled', async () => {
      try {
        await axios.get('/ssrf/http/unhandled-error?host=ifconfig.pro')

        assert.fail('Request should have failed')
      } catch (e) {
        if (!e.response) {
          throw e
        }

        assert.strictEqual(e.response.status, 403)
      }
    })

    it('should not crash the app when app send data after blocking', () => {
      return testNotCrashedAfterBlocking('/ssrf/http/unhandled-async-write-A')
    })

    it('should not crash the app when app stream data after blocking', () => {
      return testNotCrashedAfterBlocking('/ssrf/http/unhandled-async-write-B')
    })

    it('should not crash the app when setHeader, writeHead or end after blocking', () => {
      return testNotCrashedAfterBlocking('/ssrf/http/unhandled-async-write-C')
    })

    it('should not crash the app when appendHeader, flushHeaders, removeHeader after blocking', () => {
      return testNotCrashedAfterBlocking('/ssrf/http/unhandled-async-write-D')
    })

    it('should not crash the app when writeContinue after blocking', () => {
      return testNotCrashedAfterBlocking('/ssrf/http/unhandled-async-write-E')
    })

    it('should not crash the app when writeProcessing after blocking', () => {
      return testNotCrashedAfterBlocking('/ssrf/http/unhandled-async-write-F')
    })

    it('should not crash the app when writeEarlyHints after blocking', () => {
      return testNotCrashedAfterBlocking('/ssrf/http/unhandled-async-write-G')
    })

    it('should not crash the app when res.json after blocking', () => {
      return testNotCrashedAfterBlocking('/ssrf/http/unhandled-async-write-H')
    })
  })
})
