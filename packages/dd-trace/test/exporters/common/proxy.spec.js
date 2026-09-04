'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const https = require('node:https')
const { once } = require('node:events')

const { afterEach, beforeEach, describe, it } = require('mocha')

require('../../setup/core')

const { getHttpsProxyAgent } = require('../../../src/exporters/common/proxy')

const httpsRequest = https.request
const proxyEnvironmentNames = [
  'ALL_PROXY',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'all_proxy',
  'https_proxy',
  'http_proxy',
  'no_proxy',
]

describe('HTTPS proxy agent selection', () => {
  let originalEnvironment

  beforeEach(() => {
    originalEnvironment = new Map()
    for (const name of proxyEnvironmentNames) {
      originalEnvironment.set(name, process.env[name])
      delete process.env[name]
    }
  })

  afterEach(() => {
    for (const [name, value] of originalEnvironment) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }
  })

  it('routes an HTTPS request through the standard proxy', async () => {
    const proxy = http.createServer()
    let resolveTarget
    let proxySocket
    const target = new Promise(resolve => {
      resolveTarget = resolve
    })
    proxy.once('connect', (request, socket) => {
      proxySocket = socket
      resolveTarget(request.url)
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    })
    proxy.listen(0, '127.0.0.1')
    await once(proxy, 'listening')

    const directAgent = new https.Agent({ keepAlive: true, maxSockets: 4 })
    const { port } = proxy.address()
    process.env.https_proxy = `http://127.0.0.1:${port}`
    const agent = getHttpsProxyAgent('https://intake.example/path', directAgent)
    const request = httpsRequest({
      agent,
      hostname: 'intake.example',
      method: 'POST',
      path: '/path',
      port: 443,
    })
    request.on('error', () => {})
    request.end()

    try {
      assert.strictEqual(await target, 'intake.example:443')
    } finally {
      request.destroy()
      directAgent.destroy()
      agent.destroy()
      proxySocket?.destroy()
      proxy.closeAllConnections()
      await new Promise(resolve => proxy.close(resolve))
    }
  })

  it('honors NO_PROXY', () => {
    process.env.HTTPS_PROXY = 'http://proxy.example:8202'
    process.env.NO_PROXY = 'intake.example'
    const directAgent = new https.Agent()

    try {
      assert.strictEqual(
        getHttpsProxyAgent({
          protocol: 'https:',
          hostname: 'intake.example',
          port: 443,
        }, directAgent),
        directAgent
      )
    } finally {
      directAgent.destroy()
    }
  })

  it('reuses proxy agents without merging direct agent pools', () => {
    process.env.HTTPS_PROXY = 'http://proxy.example:8202'
    const payloadAgent = new https.Agent({ keepAlive: true, maxSockets: 16 })
    const mediaAgent = new https.Agent({ keepAlive: true, maxSockets: 16 })

    const firstPayloadProxy = getHttpsProxyAgent('https://intake.example/path', payloadAgent)
    const secondPayloadProxy = getHttpsProxyAgent('https://other.example/path', payloadAgent)
    const mediaProxy = getHttpsProxyAgent('https://intake.example/path', mediaAgent)

    try {
      assert.strictEqual(secondPayloadProxy, firstPayloadProxy)
      assert.notStrictEqual(mediaProxy, firstPayloadProxy)
      assert.strictEqual(firstPayloadProxy.keepAlive, true)
      assert.strictEqual(firstPayloadProxy.maxSockets, 16)
      assert.strictEqual(mediaProxy.keepAlive, true)
      assert.strictEqual(mediaProxy.maxSockets, 16)
    } finally {
      payloadAgent.destroy()
      mediaAgent.destroy()
      firstPayloadProxy.destroy()
      mediaProxy.destroy()
    }
  })

  it('rejects an invalid proxy URL', () => {
    process.env.HTTPS_PROXY = '://invalid'

    assert.throws(
      () => getHttpsProxyAgent('https://intake.example/path'),
      { code: 'ERR_INVALID_URL' }
    )
  })
})
