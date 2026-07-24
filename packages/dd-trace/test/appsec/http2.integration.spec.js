'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const { after, afterEach, before, describe, it } = require('mocha')

const agent = require('../plugins/agent')
const appsec = require('../../src/appsec')
const { getConfigFresh } = require('../helpers/config')
const { blockedTemplateJson, setTestBlockingTemplates } = require('./utils')

describe('AppSec HTTP/2 response blocking', () => {
  let http2
  let server
  let port

  before(async () => {
    await agent.load(['http2', 'http'], { client: false })
    http2 = require('node:http2')
    appsec.enable(getConfigFresh({
      appsec: {
        enabled: true,
        rules: path.join(__dirname, 'response_blocking_rules.json'),
        rasp: {
          enabled: false,
        },
        apiSecurity: {
          enabled: false,
        },
      },
    }))
    setTestBlockingTemplates()
  })

  afterEach(async () => {
    if (server) {
      await new Promise(resolve => server.close(resolve))
    }
    server = undefined
  })

  after(() => {
    appsec.disable()
    return agent.close()
  })

  /**
   * @param {() => import('node:http2').Http2Server} createServer
   */
  function listen (createServer) {
    return new Promise(resolve => {
      server = createServer()
      server.listen(0, 'localhost', () => {
        port = server.address().port
        resolve()
      })
    })
  }

  function request () {
    return new Promise((resolve, reject) => {
      const client = http2.connect(`http://localhost:${port}`).once('error', reject)
      const stream = client.request()
      const chunks = []
      let responseHeaders

      stream.once('response', headers => {
        responseHeaders = headers
      })
      stream.on('data', chunk => {
        chunks.push(chunk)
      })
      stream.once('error', reject)
      stream.once('end', () => {
        client.close()
        resolve({
          body: Buffer.concat(chunks).toString(),
          headers: responseHeaders,
        })
      })
      stream.end()
    })
  }

  it('blocks compatibility responses and suppresses subsequent writes', async () => {
    await listen(() => http2.createServer((req, res) => {
      res.writeHead(404, { k: '404' })
      res.setHeader('after-block', 'ignored')
      res.write('ignored')
      res.end('ignored')
    }))

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 403)
    assert.strictEqual(headers['after-block'], undefined)
    assert.strictEqual(body, blockedTemplateJson)
  })

  it('blocks core stream responses and suppresses subsequent writes', async () => {
    await listen(() => {
      const coreServer = http2.createServer()
      coreServer.on('stream', stream => {
        stream.respond({ ':status': 404, k: '404' })
        stream.write('ignored')
        stream.end('ignored')
      })
      return coreServer
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 403)
    assert.strictEqual(body, blockedTemplateJson)
  })

  it('allows core stream writes before respond', async () => {
    await listen(() => {
      const coreServer = http2.createServer()
      coreServer.on('stream', stream => {
        stream.write('body')
        stream.end()
      })
      return coreServer
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 200)
    assert.strictEqual(body, 'body')
  })
})
