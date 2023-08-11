'use strict'

const getPort = require('get-port')
const { assert } = require('chai')
const path = require('path')
const axios = require('axios')

const {
  FakeAgent,
  curlAndAssertMessage,
  createSandbox,
  spawnProc
} = require('../helpers')

describe(`apoollo-server`, () => {
  let sandbox, cwd, agent, webFile, proc

  before(async function () {
    sandbox = await createSandbox([`@apollo/server`, 'graphql', 'koalas'])
    cwd = sandbox.folder
    webFile = path.join(cwd, 'graphql/index.js')
  })

  beforeEach(async () => {
    proc = await spawnProc(webFile, { cwd })
    agent = await new FakeAgent().start()
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
      assert.propertyVal(headers, 'host', `127.0.0.1:8126`)
      assert.isArray(payload)
      assert.strictEqual(payload.length, 1)
      assert.isArray(payload[0])
      assert.strictEqual(payload[0].length, 1)
      assert.propertyVal(payload[0][0], 'name', 'web.request')
    }, 20000)

    console.log('algo')

    const res = axios({
      url: `http://localhost:3000/graphql`,
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
      .then((res) => {
        const response = res
        console.log(response)
      })
      .catch((err) => {
        console.log(err)
      })

    return agentPromise
  })
})
