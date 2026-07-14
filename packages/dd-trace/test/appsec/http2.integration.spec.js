'use strict'

const assert = require('node:assert/strict')
const { closeSync, openSync } = require('node:fs')
const path = require('node:path')

const { after, afterEach, before, describe, it } = require('mocha')

const { NODE_MAJOR, NODE_MINOR } = require('../../../../version')
const { FOREIGN_HTTP2_SERVER } = require('../../src/constants')
const appsec = require('../../src/appsec')
const { getConfigFresh } = require('../helpers/config')
const agent = require('../plugins/agent')
const { blockedTemplateJson, setTestBlockingTemplates } = require('./utils')

const PRESERVES_DUPLICATE_HEADERS = NODE_MAJOR >= 22 ||
  (NODE_MAJOR === 21 && NODE_MINOR >= 7) ||
  (NODE_MAJOR === 20 && NODE_MINOR >= 12)

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
   * @returns {Promise<void>}
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

  /**
   * @param {string} [requestPath]
   * @returns {Promise<{ body: string, headers: import('node:http2').IncomingHttpHeaders }>}
   */
  function request (requestPath = '/') {
    return new Promise((resolve, reject) => {
      const client = http2.connect(`http://localhost:${port}`).once('error', reject)
      const stream = client.request({ ':path': requestPath })
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
        const fileDescriptor = openSync(__filename, 'r')
        stream.once('close', () => closeSync(fileDescriptor))
        stream.respond({ ':status': 404, k: '404' })
        stream.respond({ ':status': 200 })
        stream.respondWithFD(fileDescriptor, { ':status': 200 })
        stream.respondWithFile(__filename, { ':status': 200 })
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

  it('allows core stream ends before respond', async () => {
    await listen(() => {
      const coreServer = http2.createServer()
      coreServer.on('stream', stream => stream.end('body'))
      return coreServer
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 200)
    assert.strictEqual(body, 'body')
  })

  it('preserves headers-sent errors for tracked core response methods', async () => {
    await listen(() => {
      const coreServer = http2.createServer()
      coreServer.on('stream', stream => {
        const fileDescriptor = openSync(__filename, 'r')
        stream.respond({ ':status': 200 })

        assert.throws(() => stream.respond({ ':status': 200 }), { code: 'ERR_HTTP2_HEADERS_SENT' })
        assert.throws(
          () => stream.respondWithFD(fileDescriptor, { ':status': 200 }),
          { code: 'ERR_HTTP2_HEADERS_SENT' }
        )
        assert.throws(
          () => stream.respondWithFile(__filename, { ':status': 200 }),
          { code: 'ERR_HTTP2_HEADERS_SENT' }
        )

        closeSync(fileDescriptor)
        stream.write('body')
        stream.end()
      })
      return coreServer
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 200)
    assert.strictEqual(body, 'body')
  })

  it('preserves invalid options errors for tracked file response methods', async () => {
    await listen(() => {
      const coreServer = http2.createServer()
      coreServer.on('stream', stream => {
        const fileDescriptor = openSync(__filename, 'r')

        assert.throws(() => stream.respondWithFD(fileDescriptor, {}, null), TypeError)
        assert.throws(() => stream.respondWithFile(__filename, {}, null), TypeError)

        closeSync(fileDescriptor)
        stream.respond({ ':status': 200 })
        stream.end('body')
      })
      return coreServer
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 200)
    assert.strictEqual(body, 'body')
  })

  it('does not affect untracked core stream response methods after wrapping their prototype', async () => {
    await listen(() => {
      const coreServer = http2.createServer()
      coreServer[FOREIGN_HTTP2_SERVER] = true
      coreServer.on('stream', (stream, headers) => {
        if (headers[':path'] === '/respond') {
          stream.respond({ ':status': 200 })
          stream.end('body')
        } else if (headers[':path'] === '/fd') {
          const fileDescriptor = openSync(__filename, 'r')
          stream.once('close', () => closeSync(fileDescriptor))
          stream.respondWithFD(fileDescriptor, { ':status': 200 })
        } else {
          stream.respondWithFile(__filename, { ':status': 200 })
        }
      })
      return coreServer
    })

    const [respondResponse, fileDescriptorResponse, fileResponse] = await Promise.all([
      request('/respond'),
      request('/fd'),
      request('/file'),
    ])

    assert.strictEqual(respondResponse.headers[':status'], 200)
    assert.strictEqual(respondResponse.body, 'body')
    assert.strictEqual(fileDescriptorResponse.headers[':status'], 200)
    assert.notStrictEqual(fileDescriptorResponse.body, blockedTemplateJson)
    assert.strictEqual(fileResponse.headers[':status'], 200)
    assert.notStrictEqual(fileResponse.body, blockedTemplateJson)
  })

  it('does not inspect respondWithFile headers when opening the file fails', async () => {
    await listen(() => {
      const coreServer = http2.createServer()
      coreServer.on('stream', stream => {
        stream.respondWithFile(
          path.join(__dirname, 'missing-http2-response'),
          { ':status': 404, k: '404' },
          {
            onError () {
              stream.respond({ ':status': 200 })
              stream.end('fallback')
            },
          }
        )
      })
      return coreServer
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 200)
    assert.strictEqual(body, 'fallback')
  })

  it('inspects fallback headers after respondWithFile fails', async () => {
    await listen(() => {
      const coreServer = http2.createServer()
      coreServer.on('stream', stream => {
        stream.respondWithFile(
          path.join(__dirname, 'missing-http2-response'),
          { ':status': 200 },
          {
            onError () {
              stream.respond({ ':status': 404, k: '404' })
              stream.end('fallback')
            },
          }
        )
      })
      return coreServer
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 403)
    assert.strictEqual(body, blockedTemplateJson)
  })

  it('inspects respondWithFile headers after statCheck mutates them', async () => {
    await listen(() => {
      const coreServer = http2.createServer()
      coreServer.on('stream', stream => {
        stream.respondWithFile(__filename, { ':status': 200 }, {
          statCheck (stat, headers) {
            headers[':status'] = 404
            headers.k = '404'
            return true
          },
        })
      })
      return coreServer
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 403)
    assert.strictEqual(body, blockedTemplateJson)
  })

  it('does not inspect replaced respondWithFile headers before statCheck returns', async () => {
    await listen(() => {
      const coreServer = http2.createServer()
      coreServer.on('stream', stream => {
        stream.respondWithFile(__filename, { ':status': 404, k: '404' }, {
          statCheck (stat, headers) {
            headers[':status'] = 200
            delete headers.k
            return true
          },
        })
      })
      return coreServer
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 200)
    assert.notStrictEqual(body, blockedTemplateJson)
  })

  it('does not inspect respondWithFile headers when statCheck sends a fallback', async () => {
    await listen(() => {
      const coreServer = http2.createServer()
      coreServer.on('stream', stream => {
        stream.respondWithFile(__filename, { ':status': 404, k: '404' }, {
          statCheck () {
            stream.respond({ ':status': 200 })
            stream.end('fallback')
            return false
          },
        })
      })
      return coreServer
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 200)
    assert.strictEqual(body, 'fallback')
  })

  it('blocks respondWithFD headers without statCheck', async () => {
    await listen(() => {
      const coreServer = http2.createServer()
      coreServer.on('stream', stream => {
        const fileDescriptor = openSync(__filename, 'r')
        stream.once('close', () => closeSync(fileDescriptor))
        stream.respondWithFD(fileDescriptor, { ':status': 404, k: '404' })
      })
      return coreServer
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 403)
    assert.strictEqual(body, blockedTemplateJson)
  })

  it('inspects respondWithFD headers after statCheck mutates them', async () => {
    await listen(() => {
      const coreServer = http2.createServer()
      coreServer.on('stream', stream => {
        const fileDescriptor = openSync(__filename, 'r')
        stream.once('close', () => closeSync(fileDescriptor))
        stream.respondWithFD(fileDescriptor, { ':status': 200 }, {
          statCheck (stat, headers) {
            headers[':status'] = 404
            headers.k = '404'
            return true
          },
        })
      })
      return coreServer
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 403)
    assert.strictEqual(body, blockedTemplateJson)
  })

  it('preserves compatibility duplicate header values when Node does', async () => {
    await listen(() => http2.createServer((req, res) => {
      res.writeHead(200, [['K', 'bad1'], ['k', 'bad2'], ['K', 'bad3']])
      res.end()
    }))

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], PRESERVES_DUPLICATE_HEADERS ? 403 : 200)
    assert.strictEqual(body, PRESERVES_DUPLICATE_HEADERS ? blockedTemplateJson : '')
  })

  it('preserves core stream duplicate header values across casing', async () => {
    await listen(() => {
      const coreServer = http2.createServer()
      coreServer.on('stream', stream => {
        stream.respond({ ':status': 200, K: 'bad1', k: ['bad2', 'bad3'] })
        stream.end()
      })
      return coreServer
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 403)
    assert.strictEqual(body, blockedTemplateJson)
  })
})
