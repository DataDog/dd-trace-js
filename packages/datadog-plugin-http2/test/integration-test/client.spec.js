'use strict'

const {
  FakeAgent,
  createSandbox,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { assert } = require('chai')
const http2 = require('http2')

describe('esm', () => {
  let agent
  let proc
  let sandbox

  before(async function () {
    this.timeout(50000)
    sandbox = await createSandbox(['http2'], false, [
      './packages/datadog-plugin-http2/test/integration-test/*'])
  })

  after(async function () {
    this.timeout(50000)
    await sandbox.remove()
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()
  })

  afterEach(async () => {
    proc && proc.kill()
    await agent.stop()
  })

  context('http2', () => {
    for (const variant of ['default', 'destructure', 'star']) {
      it(`is instrumented (${variant})`, async () => {
        proc = await spawnPluginIntegrationTestProc(sandbox.folder, `server-${variant}.mjs`, agent.port)
        const resultPromise = agent.assertMessageReceived(({ headers, payload }) => {
          assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
          assert.isArray(payload)
          assert.strictEqual(payload.length, 1)
          assert.isArray(payload[0])
          assert.strictEqual(payload[0].length, 1)
          assert.propertyVal(payload[0][0], 'name', 'web.request')
          assert.propertyVal(payload[0][0].meta, 'component', 'http2')
        })
        await curl(proc)
        return resultPromise
      }).timeout(50000)
    }
  })
})

async function curl (url) {
  if (url !== null && typeof url === 'object') {
    if (url.then) {
      return curl(await url)
    }
    url = url.url
  }

  const urlObject = new URL(url)
  return new Promise((resolve, reject) => {
    const client = http2.connect(urlObject.origin)
    client.on('error', reject)

    const req = client.request({
      ':path': urlObject.pathname,
      ':method': 'GET'
    })
    req.on('error', reject)

    const chunks = []
    req.on('data', (chunk) => {
      chunks.push(chunk)
    })

    req.on('end', () => {
      resolve(Buffer.concat(chunks))
    })

    req.end()
  })
}
