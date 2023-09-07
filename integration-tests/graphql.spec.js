'use strict'

const getPort = require('get-port')
const { assert } = require('chai')
const path = require('path')
const axios = require('axios')

const {
  FakeAgent,
  createSandbox,
  spawnProc
} = require('./helpers')

describe('graphql', () => {
  let sandbox, cwd, agent, webFile, proc, appPort

  before(async function () {
    sandbox = await createSandbox([`@apollo/server`, 'graphql', 'koalas'])
    cwd = sandbox.folder
    webFile = path.join(cwd, 'graphql/index.js')
    appPort = await getPort()
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()
    proc = await spawnProc(webFile, {
      cwd,
      env: {
        AGENT_PORT: agent.port,
        APP_PORT: appPort
      }
    })
  })

  afterEach(async () => {
    proc.kill()
    await agent.stop()
  })

  after(async () => {
    await sandbox.remove()
  })

  it('should not report any attack', async () => {
    const agentPromise = agent.assertMessageReceived(({ headers, payload }) => {
      assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
      assert.isArray(payload)
      assert.strictEqual(payload.length, 2)
      assert.propertyVal(payload[1][0], 'name', 'express.request')
      assert.propertyVal(payload[1][0].metrics, '_dd.appsec.enabled', 1)
      assert.property(payload[1][0].metrics, '_dd.appsec.waf.duration')
      assert.notProperty(payload[1][0].meta, '_dd.appsec.event')
      assert.notProperty(payload[1][0].meta, '_dd.appsec.json')
    })

    await axios({
      url: `http://localhost:${appPort}/graphql`,
      method: 'post',
      headers: {
        'Content-type': 'application/json'
      },
      data: {
        query: 'query getSingleImage($imageId: Int!) { image(imageId: $imageId) { title owner category url }}',
        variables: {
          imageId: 1
        },
        operationName: 'getSingleImage'
      }
    })

    return agentPromise
  })

  it('should report an attack', async () => {
    const result = {
      triggers: [
        {
          rule:
          {
            id: 'test-rule-id-1',
            name: 'test-rule-name-1',
            on_match: ['block'],
            tags:
            {
              category: 'attack_attempt',
              type: 'security_scanner'
            }
          },
          rule_matches: [
            {
              operator: 'phrase_match',
              operator_value: '',
              parameters: [
                {
                  address: 'graphql.server.all_resolvers',
                  key_path: ['images', '0', 'category'],
                  value: 'testattack',
                  highlight: ['testattack']
                }
              ]
            }
          ]
        }
      ]
    }

    const agentPromise = agent.assertMessageReceived(({ headers, payload }) => {
      assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
      assert.isArray(payload)
      assert.strictEqual(payload.length, 2)
      assert.propertyVal(payload[1][0], 'name', 'express.request')
      assert.propertyVal(payload[1][0].metrics, '_dd.appsec.enabled', 1)
      assert.property(payload[1][0].metrics, '_dd.appsec.waf.duration')
      assert.propertyVal(payload[1][0].meta, 'appsec.event', 'true')
      assert.property(payload[1][0].meta, '_dd.appsec.json')
      assert.propertyVal(payload[1][0].meta, '_dd.appsec.json', JSON.stringify(result))
    })

    await axios({
      url: `http://localhost:${appPort}/graphql`,
      method: 'post',
      headers: {
        'Content-type': 'application/json'
      },
      data: {
        query: 'query getImagesByCategory($category: String) { images(category: $category) { title owner url }}',
        variables: {
          category: 'testattack'
        },
        operationName: 'getImagesByCategory'
      }
    })

    return agentPromise
  })
})
