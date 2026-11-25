'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const path = require('node:path')

const { describe, it, before, after } = require('mocha')

const agent = require('../../plugins/agent')
const appsec = require('../../../src/appsec')
const { getConfigFresh } = require('../../helpers/config')
const { withVersions } = require('../../setup/mocha')
const HttpRequest = require('../../setup/helpers/http-client')
const { checkRaspExecutedAndNotThreat, checkRaspExecutedAndHasThreat } = require('./utils')

describe('RASP - sql_injection with sequelize', () => {
  withVersions('sequelize', 'sequelize', sequelizeVersion => {
    withVersions('sequelize', 'express', expressVersion => {
      let sequelize, server, httpRequest

      before(async () => {
        await agent.load(['express', 'http', 'mysql2'], { client: false })

        const { Sequelize } = require(`../../../../../versions/sequelize@${sequelizeVersion}`).get()
        sequelize = new Sequelize('db', 'root', '', {
          host: '127.0.0.1',
          dialect: 'mysql',
          logging: false,
        })
        // Connect outside of the test requests, so their queries are the only ones RASP evaluates.
        await sequelize.authenticate()

        const express = require(`../../../../../versions/express@${expressVersion}`).get()
        const expressApp = express()

        // Sequelize rejects with its own error, which keeps the abort error in `parent` and `original`.
        function query (req) {
          return sequelize.query(`SELECT 1 AS one WHERE 'a' = '${req.query.param}'`)
        }

        expressApp.get('/', (req, res, next) => {
          query(req).then(rows => res.json(rows), next)
        })

        expressApp.get('/replaced', (req, res, next) => {
          query(req).then(rows => res.json(rows), () => next(new Error('Application error')))
        })

        const handled = express.Router()
        handled.get('/', (req, res, next) => {
          query(req).then(rows => res.json(rows), next)
        })
        handled.use((error, req, res, next) => {
          res.status(502).end('Application error handler')
        })
        expressApp.use('/handled', handled)

        appsec.enable(getConfigFresh({
          appsec: {
            enabled: true,
            rules: path.join(__dirname, 'resources', 'rasp_rules.json'),
            rasp: { enabled: true },
          },
        }))

        server = expressApp.listen(0)
        await once(server, 'listening')
        const port = (/** @type {import('net').AddressInfo} */ (server.address())).port
        httpRequest = HttpRequest.create({
          baseURL: `http://localhost:${port}`,
          validateStatus: () => true,
        })
      })

      after(async () => {
        appsec.disable()
        server.close()
        await sequelize.close()
        await agent.close()
      })

      it('should not block a query without attack', async () => {
        const [res] = await Promise.all([
          httpRequest.get('/?param=a'),
          checkRaspExecutedAndNotThreat(agent),
        ])

        assert.strictEqual(res.status, 200)
      })

      it('should block a query when sequelize wraps the abort error', async () => {
        const [res, span] = await Promise.all([
          httpRequest.get('/?param=\' OR 1 = 1 --'),
          checkRaspExecutedAndHasThreat(agent, 'rasp-sqli-rule-id-2'),
        ])

        assert.strictEqual(res.status, 403)
        assert.strictEqual(span.meta['appsec.blocked'], 'true')
      })

      it('should block a query when an error handler of the application answers the sequelize error', async () => {
        const [res, span] = await Promise.all([
          httpRequest.get('/handled?param=\' OR 1 = 1 --'),
          checkRaspExecutedAndHasThreat(agent, 'rasp-sqli-rule-id-2'),
        ])

        assert.strictEqual(res.status, 403)
        assert.strictEqual(span.meta['appsec.blocked'], 'true')
      })

      it('should not block a query when the application replaces the sequelize error', async () => {
        const [res, span] = await Promise.all([
          httpRequest.get('/replaced?param=\' OR 1 = 1 --'),
          checkRaspExecutedAndHasThreat(agent, 'rasp-sqli-rule-id-2'),
        ])

        assert.strictEqual(res.status, 500)
        assert.ok(!('appsec.blocked' in span.meta))
      })
    })
  })
})
