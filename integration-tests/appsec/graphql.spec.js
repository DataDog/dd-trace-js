'use strict'

const assert = require('node:assert/strict')
const path = require('path')
const { inspect } = require('node:util')

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  spawnProc,
  stopProc,
} = require('../helpers')

describe('graphql', () => {
  let cwd, agent, webFile, proc

  useSandbox(['@apollo/server', 'graphql'])

  before(function () {
    cwd = sandboxCwd()
    webFile = path.join(cwd, 'graphql/index.js')
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()
    proc = await spawnProc(webFile, {
      cwd,
      env: {
        AGENT_PORT: agent.port,
      },
    })
  })

  afterEach(async () => {
    await stopProc(proc)
    await agent.stop()
  })

  /**
   * @param {object|object[]} body
   */
  async function request (body) {
    const response = await fetch(`${proc.url}/graphql`, {
      method: 'post',
      headers: { 'Content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    await response.arrayBuffer()
    return response
  }

  it('should not report any attack', async () => {
    const agentPromise = agent.assertMessageReceived(({ headers, payload }) => {
      assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
      assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
      assert.strictEqual(payload.length, 2)
      // Apollo server 5 is using Node.js http server instead of express
      assert.strictEqual(payload[1][0].name, 'web.request')
      assert.strictEqual(payload[1][0].metrics['_dd.appsec.enabled'], 1)
      assert.ok(
        Object.hasOwn(payload[1][0].metrics, '_dd.appsec.waf.duration'),
        `Available keys: ${inspect(Object.keys(payload[1][0].metrics))}`
      )
      assert.ok(!('_dd.appsec.event' in payload[1][0].meta))
      assert.ok(!('_dd.appsec.json' in payload[1][0].meta))
    })

    const response = await request({
      query: 'query getSingleImage($imageId: Int!) { image(imageId: $imageId) { title owner category url }}',
      variables: {
        imageId: 1,
      },
      operationName: 'getSingleImage',
    })
    assert.strictEqual(response.status, 200)

    return agentPromise
  })

  it('should report an attack', async () => {
    const result = {
      triggers: [
        {
          rule: {
            id: 'test-rule-id-1',
            name: 'test-rule-name-1',
            tags:
            {
              type: 'security_scanner',
              category: 'attack_attempt',
            },
            on_match: [],
          },
          rule_matches: [
            {
              operator: 'phrase_match',
              operator_value: '',
              parameters: [
                {
                  address: 'graphql.server.resolver',
                  key_path: ['images', 'category'],
                  value: 'testattack',
                  highlight: ['testattack'],
                },
              ],
            },
          ],
        },
      ],
    }

    const agentPromise = agent.assertMessageReceived(({ headers, payload }) => {
      assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
      assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
      assert.strictEqual(payload.length, 2)
      // Apollo server 5 is using Node.js http server instead of express
      assert.strictEqual(payload[1][0].name, 'web.request')
      assert.strictEqual(payload[1][0].metrics['_dd.appsec.enabled'], 1)
      assert.ok(
        Object.hasOwn(payload[1][0].metrics, '_dd.appsec.waf.duration'),
        `Available keys: ${inspect(Object.keys(payload[1][0].metrics))}`
      )
      assert.strictEqual(payload[1][0].meta['appsec.event'], 'true')
      assert.ok(
        Object.hasOwn(payload[1][0].meta, '_dd.appsec.json'),
        `Available keys: ${inspect(Object.keys(payload[1][0].meta))}`
      )
      assert.deepStrictEqual(JSON.parse(payload[1][0].meta['_dd.appsec.json']), result)
    })

    const response = await request({
      query: 'query getImagesByCategory($category: String) { images(category: $category) { title owner url }}',
      variables: {
        category: 'testattack',
      },
      operationName: 'getImagesByCategory',
    })
    assert.strictEqual(response.status, 200)

    return agentPromise
  })

  it('should block an attack', async () => {
    const agentPromise = agent.assertMessageReceived(({ headers, payload }) => {
      assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
      assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
      assert.strictEqual(payload.length, 2)
      // Apollo server 5 is using Node.js http server instead of express
      assert.strictEqual(payload[1][0].name, 'web.request')
      assert.strictEqual(payload[1][0].metrics['_dd.appsec.enabled'], 1)
      assert.strictEqual(payload[1][0].meta['appsec.blocked'], 'true')
      assert.strictEqual(payload[1][0].meta['appsec.event'], 'true')
    })

    const response = await request({
      query: 'query getImagesByCategory($category: String) { images(category: $category) { title owner url }}',
      variables: {
        category: 'blockattack',
      },
      operationName: 'getImagesByCategory',
    })
    assert.strictEqual(response.status, 403)

    return agentPromise
  })

  it('should block an attack in a batched request', async () => {
    const agentPromise = agent.assertMessageReceived(({ headers, payload }) => {
      assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
      assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
      assert.strictEqual(payload.length, 2)
      // Apollo server 5 is using Node.js http server instead of express
      assert.strictEqual(payload[1][0].name, 'web.request')
      assert.strictEqual(payload[1][0].metrics['_dd.appsec.enabled'], 1)
      assert.strictEqual(payload[1][0].meta['appsec.blocked'], 'true')
      assert.strictEqual(payload[1][0].meta['appsec.event'], 'true')
    })

    const response = await request([
      {
        query: 'query getSingleImage($imageId: Int!) { image(imageId: $imageId) { title }}',
        variables: { imageId: 1 },
        operationName: 'getSingleImage',
      },
      {
        query: 'query getImagesByCategory($category: String) { images(category: $category) { title }}',
        variables: { category: 'blockattack' },
        operationName: 'getImagesByCategory',
      },
    ])
    assert.strictEqual(response.status, 403)

    return agentPromise
  })
})
