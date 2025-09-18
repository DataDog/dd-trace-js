'use strict'

const path = require('node:path')
const agent = require('../../plugins/agent')
const Config = require('../../../src/config')
const appsec = require('../../../src/appsec')

const Axios = require('axios')
const { assert } = require('chai')
const { describe, it, afterEach, before, after } = require('mocha')
const sinon = require('sinon')

const { withVersions } = require('../../setup/mocha')
const { json: blockedJson } = require('../../../src/appsec/blocked_templates')
const { checkRaspExecutedAndNotThreat, checkRaspExecutedAndHasThreat } = require('./utils')

describe('RASP - fastify blocking', () => {
  withVersions('fastify', 'fastify', '>=2', (version) => {
    let app, hooks, axios

    before(async () => {
      await agent.load(['http', 'fastify'], { client: false })

      appsec.enable(new Config({
        appsec: {
          enabled: true,
          rules: path.join(__dirname, 'resources', 'rasp_rules.json'),
          rasp: { enabled: true }
        }
      }))

      const fastify = require(`../../../../../versions/fastify@${version}`).get()
      app = fastify()

      hooks = {
        onSend: sinon.stub().resolves(),
        onResponse: sinon.stub().resolves(),
        onError: sinon.stub().resolves()
      }

      for (const [k, v] of Object.entries(hooks)) {
        app.addHook(k, v)
      }

      const childProcess = require('child_process')
      const fs = require('fs')
      const pg = require('../../../../../versions/pg@8.7.3').get()
      const pool = new pg.Pool({
        host: '127.0.0.1',
        user: 'postgres',
        password: 'postgres',
        database: 'postgres',
        application_name: 'test'
      })
      const http = require('http')

      app.get('/error', async (request, reply) => {
        throw new Error('loul')
      })

      app.get('/cmdi', async (request, reply) => {
        return childProcess.execFileSync('sh', ['-c', request.query.payload]).toString()
      })

      app.get('/shi', async (request, reply) => {
        return childProcess.execSync(`ls ${request.query.payload ?? ''}`).toString()
      })

      app.get('/lfi', async (request, reply) => {
        return fs.readFileSync(request.query.payload)
      })

      app.get('/sqli', async (request, reply) => {
        return pool.query(`SELECT * FROM users WHERE id='${request.query.payload}'`)
      })

      app.get('/ssrf', async (request, reply) => {
        await new Promise((resolve, reject) => {
          http.get(`http://${request.query.payload}`, () => {
            resolve()
          })
        })
      })

      await app.listen()

      axios = Axios.create({
        baseURL: `http://localhost:${app.server.address().port}`,
        validateStatus: () => true,
        responseType: 'text'
      })
    })

    afterEach(() => {
      sinon.resetHistory()
    })

    after(async () => {
      await app.server.close()
      appsec.disable()
      await agent.close({ ritmReset: false })
    })

    it('should not block on user error', async () => {
      const res = await axios('/error')

      sinon.assert.calledOnce(hooks.onSend)
      sinon.assert.calledOnce(hooks.onResponse)
      sinon.assert.calledOnce(hooks.onError)
      assert.strictEqual(res.status, 500)
      assert.notStrictEqual(res.data, blockedJson)
      assert(res.data.includes('loul'))
      await checkRaspExecutedAndNotThreat(agent, false)
    })

    it('should not block without attack', async () => {
      const res = await axios('/shi')

      sinon.assert.calledOnce(hooks.onSend)
      sinon.assert.calledOnce(hooks.onResponse)
      sinon.assert.notCalled(hooks.onError)
      assert.strictEqual(res.status, 200)
      assert.notStrictEqual(res.data, blockedJson)
      await checkRaspExecutedAndNotThreat(agent, true)
    })

    it('should block with CMDI', async () => {
      const res = await axios('/cmdi?payload=cat /etc/passwd')

      sinon.assert.calledOnce(hooks.onSend)
      sinon.assert.calledOnce(hooks.onResponse)
      sinon.assert.calledOnce(hooks.onError)
      assert.strictEqual(res.status, 403)
      assert.strictEqual(res.data, blockedJson)
      await checkRaspExecutedAndHasThreat(agent, 'rasp-command_injection-rule-id-4')
    })

    it('should block with SHI', async () => {
      const res = await axios('/shi?payload=$(cat /etc/passwd 1>%262 ; echo .)')

      sinon.assert.calledOnce(hooks.onSend)
      sinon.assert.calledOnce(hooks.onResponse)
      sinon.assert.calledOnce(hooks.onError)
      assert.strictEqual(res.status, 403)
      assert.strictEqual(res.data, blockedJson)
      await checkRaspExecutedAndHasThreat(agent, 'rasp-command_injection-rule-id-3')
    })

    it('should block with LFI', async () => {
      const res = await axios('/lfi?payload=/etc/passwd')

      sinon.assert.calledOnce(hooks.onSend)
      sinon.assert.calledOnce(hooks.onResponse)
      sinon.assert.calledOnce(hooks.onError)
      assert.strictEqual(res.status, 403)
      assert.strictEqual(res.data, blockedJson)
      await checkRaspExecutedAndHasThreat(agent, 'rasp-lfi-rule-id-5')
    })

    it('should block with SQLI', async () => {
      const res = await axios('/sqli?payload=\' OR 1 = 1 --')

      sinon.assert.calledOnce(hooks.onSend)
      sinon.assert.calledOnce(hooks.onResponse)
      sinon.assert.calledOnce(hooks.onError)
      assert.strictEqual(res.status, 403)
      assert.strictEqual(res.data, blockedJson)
      await checkRaspExecutedAndHasThreat(agent, 'rasp-sqli-rule-id-2')
    })

    it('should block with SSRF', async () => {
      const res = await axios('/ssrf?payload=169.254.169.254')

      // some hooks won't be called because SSRF is blocked out of band
      sinon.assert.notCalled(hooks.onSend)
      sinon.assert.calledOnce(hooks.onResponse)
      sinon.assert.notCalled(hooks.onError)
      assert.strictEqual(res.status, 403)
      assert.strictEqual(res.data, blockedJson)
      await checkRaspExecutedAndHasThreat(agent, 'rasp-ssrf-rule-id-1')
    })
  })
})
