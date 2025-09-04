'use strict'

const { describe, it, before, beforeEach, afterEach, after } = require('mocha')

const assert = require('node:assert')
const http2 = require('node:http2')

const {
  assertObjectContains,
  FakeAgent,
  createSandbox,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')

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

  describe('http2', () => {
    it('is instrumented without default', async () => {
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port)
      const resultPromise = agent.assertMessageReceived(({ headers, payload }) => {
        assertObjectContains(headers, { host: `127.0.0.1:${agent.port}` })
        assertObjectContains(
          payload,
          [[{ name: 'web.request', resource: 'GET', meta: { component: 'http2' } }]]
        )
        assert.strictEqual(payload.length, 1)
        assert.strictEqual(payload[0].length, 1)
      })
      await curl(proc)
      return resultPromise
    }).timeout(50000)

    it('is instrumented with default export', async () => {
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server-default-export.mjs', agent.port)
      const resultPromise = agent.assertMessageReceived(({ headers, payload }) => {
        assertObjectContains(headers, { host: `127.0.0.1:${agent.port}` })
        assertObjectContains(
          payload,
          [[{ name: 'web.request', resource: 'GET', meta: { component: 'http2' } }]]
        )
        assert.strictEqual(payload.length, 1)
        assert.strictEqual(payload[0].length, 1)
      })
      await curl(proc)
      return resultPromise
    }).timeout(50000)
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
