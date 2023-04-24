'use strict'

const axios = require('axios')
const getPort = require('get-port')
const path = require('path')
const os = require('os')
const fs = require('fs')
const agent = require('../plugins/agent')
const appsec = require('../../src/appsec')
const Config = require('../../src/config')

withVersions('express', 'express', version => {
  describe('Suspicious request blocking - query', () => {
    let port, server, requestBody, rulesPath

    before(() => {
      return agent.load(['express', 'http'], { client: false })
    })

    before((done) => {
      const express = require('../../../../versions/express').get()

      const app = express()
      app.get('/', (req, res) => {
        requestBody()
        res.end('DONE')
      })

      getPort().then(newPort => {
        port = newPort
        server = app.listen(port, () => {
          done()
        })
      })
    })

    before(() => {
      const rules = {
        version: '2.2',
        metadata: {
          rules_version: '1.5.0'
        },
        rules: [
          {
            id: 'test-rule-id-1',
            name: 'test-rule-name-1',
            tags: {
              type: 'security_scanner',
              category: 'attack_attempt'
            },
            conditions: [
              {
                parameters: {
                  inputs: [
                    {
                      address: 'server.request.query'
                    }
                  ],
                  list: [
                    'testattack'
                  ]
                },
                operator: 'phrase_match'
              }
            ],
            transformers: ['lowercase'],
            on_match: ['block']
          }
        ]
      }
      rulesPath = path.join(os.tmpdir(), 'test-body-suspicious-request-blocking-rules.json')
      try {
        fs.unlinkSync(rulesPath)
      } catch {
        // do nothing
      }
      fs.writeFileSync(rulesPath, JSON.stringify(rules))
    })

    beforeEach(async () => {
      requestBody = sinon.stub()
      appsec.enable(new Config({ appsec: { enabled: true, rules: rulesPath } }))
    })

    afterEach(() => {
      appsec.disable()
    })

    after(() => {
      try {
        fs.unlinkSync(rulesPath)
      } catch {
        // do nothing
      }
      server.close()
      return agent.close({ ritmReset: false })
    })

    it('should not block the request without an attack', async () => {
      const res = await axios.get(`http://localhost:${port}/?key=value`)

      expect(requestBody).to.be.calledOnce
      expect(res.data).to.be.equal('DONE')
    })

    it('should block the request when attack is detected', async () => {
      const data = {
        errors: [
          {
            title: "You've been blocked",
            detail: 'Sorry, you cannot access this page. Please contact the customer service team. Security provided' +
            ' by Datadog.'
          }
        ]
      }

      try {
        await axios.get(`http://localhost:${port}/?key=testattack`)

        return Promise.reject(new Error('Request should not return 200'))
      } catch (e) {
        expect(e.response.status).to.be.equals(403)
        expect(e.response.data).to.be.deep.equal(data)
        expect(requestBody).not.to.be.called
      }
    })
  })
})
