'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const path = require('node:path')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const request = require('../../src/exporters/common/request')
const { AIGuardClientError } = require('../../src/aiguard/errors')
const TAGS = require('../../src/aiguard/tags')

const proxyVariables = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy',
  'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']
const ssl = path.join(__dirname, '../../../datadog-plugin-http/test/ssl')
const messages = [{ role: 'user', content: 'Hello' }]
const meta = { service: 'test', env: 'test' }
const evaluation = { data: { attributes: { action: 'ALLOW', is_blocking_enabled: false } } }

describe('AI Guard client transport', () => {
  let environment
  let server
  let proxy
  let sockets
  let connects
  let received
  let endpoint
  let proxyUrl
  let client
  let respond
  let rejectConnect
  let originalFetch

  beforeEach(async () => {
    environment = new Map(proxyVariables.map(name => [name, process.env[name]]))
    for (const name of proxyVariables) delete process.env[name]
    sockets = new Set()
    connects = []
    received = []
    rejectConnect = false
    originalFetch = global.fetch
    respond = (req, res) => res.end(JSON.stringify(evaluation))
    server = https.createServer({
      key: fs.readFileSync(path.join(ssl, 'test.key')),
      cert: fs.readFileSync(path.join(ssl, 'test.crt')),
    }, (req, res) => {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        received.push({ headers: req.headers, url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) })
        respond(req, res)
      })
    })
    proxy = http.createServer()
    const track = socket => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.on('error', () => {})
    }
    server.on('connection', track)
    proxy.on('connection', track)
    proxy.on('connect', (req, socket, head) => {
      connects.push(req.url)
      if (rejectConnect) {
        socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n')
        return
      }
      const upstream = net.connect(server.address().port, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        upstream.write(head)
        socket.pipe(upstream).pipe(socket)
      })
      track(upstream)
    })
    server.listen(0, '127.0.0.1')
    proxy.listen(0, '127.0.0.1')
    await Promise.all([once(server, 'listening'), once(proxy, 'listening')])
    endpoint = `https://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`
    proxyUrl = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (proxy.address()).port}`
    // Trust only these test requests: the existing TLS fixture is self-signed and expired.
    const Client = proxyquire('../../src/aiguard/client', {
      '../exporters/common/request': (data, options, callback) => {
        request(data, { ...options, rejectUnauthorized: false }, callback)
      },
    })
    client = new Client({
      DD_API_KEY: 'test-api-key',
      DD_APP_KEY: 'test-app-key',
      aiguard: { DD_AI_GUARD_ENDPOINT: endpoint, DD_AI_GUARD_TIMEOUT: 1000 },
    })
  })

  afterEach(async () => {
    sinon.restore()
    for (const [name, value] of environment) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    for (const socket of sockets) socket.destroy()
    await Promise.all([server, proxy].map(server => new Promise(resolve => server.close(resolve))))
  })

  it('sends the evaluation through HTTPS_PROXY without changing global fetch', async () => {
    process.env.HTTPS_PROXY = proxyUrl
    const result = await client.evaluate(messages, meta)
    assert.equal(result.action, 'ALLOW')
    assert.deepEqual(connects, [`127.0.0.1:${server.address().port}`])
    assert.deepEqual(received[0].body, { data: { attributes: { messages, meta } } })
    assert.equal(received[0].url, '/evaluate')
    assert.equal(received[0].headers['dd-api-key'], 'test-api-key')
    assert.equal(received[0].headers['dd-application-key'], 'test-app-key')
    assert.equal(global.fetch, originalFetch)
    // An application-owned HTTPS request still connects directly despite HTTPS_PROXY.
    await new Promise((resolve, reject) => {
      const req = https.request(`${endpoint}/application`, {
        method: 'POST', rejectUnauthorized: false,
      }, res => {
        res.resume()
        res.once('end', resolve)
      })
      req.once('error', reject)
      req.end('{}')
    })
    assert.equal(connects.length, 1)
    assert.equal(received[1].url, '/application')
  })

  it('uses direct transport without relying on global fetch when no proxy is configured', async () => {
    const fetch = sinon.stub(global, 'fetch').throws(new Error('Application-owned fetch'))
    assert.equal((await client.evaluate(messages, meta)).action, 'ALLOW')
    assert.deepEqual(connects, [])
    sinon.assert.notCalled(fetch)
  })

  for (const viaProxy of [false, true]) {
    it(`sends concurrent evaluations ${viaProxy ? 'through the proxy' : 'directly'}`, async () => {
      if (viaProxy) process.env.HTTPS_PROXY = proxyUrl
      const count = 5
      const responses = []
      respond = (req, res) => {
        responses.push(res)
        if (responses.length === count) {
          for (const response of responses) response.end(JSON.stringify(evaluation))
        }
      }

      const results = await Promise.all(Array.from({ length: count }, () => client.evaluate(messages, meta)))
      assert.deepEqual(results.map(result => result.action), Array(count).fill('ALLOW'))
      assert.equal(received.length, count)
      assert.equal(connects.length, viaProxy ? count : 0)
    })
  }

  it('bypasses the proxy when NO_PROXY matches', async () => {
    process.env.HTTPS_PROXY = proxyUrl
    process.env.NO_PROXY = '127.0.0.1'
    assert.equal((await client.evaluate(messages, meta)).action, 'ALLOW')
    assert.deepEqual(connects, [])
  })

  it('uses the proxy when NO_PROXY does not match', async () => {
    process.env.HTTPS_PROXY = proxyUrl
    process.env.NO_PROXY = 'other.example'
    assert.equal((await client.evaluate(messages, meta)).action, 'ALLOW')
    assert.equal(connects.length, 1)
  })

  it('reports an invalid proxy configuration as a client error', async () => {
    process.env.HTTPS_PROXY = 'http://['
    await assert.rejects(client.evaluate(messages, meta), error => {
      assert.ok(error instanceof AIGuardClientError)
      assert.equal(error.telemetryType, TAGS.ERROR_TYPE_CLIENT)
      return true
    })
    assert.equal(received.length, 0)
  })

  it('prefers https_proxy over HTTPS_PROXY', async () => {
    process.env.HTTPS_PROXY = 'http://invalid.invalid:8080'
    process.env.https_proxy = proxyUrl
    assert.equal((await client.evaluate(messages, meta)).action, 'ALLOW')
    assert.equal(connects.length, 1)
  })

  it('preserves API status and error details without retrying', async () => {
    process.env.HTTPS_PROXY = proxyUrl
    const errors = [{ title: 'Service unavailable' }]
    respond = (req, res) => {
      res.writeHead(503)
      res.end(JSON.stringify({ errors }))
    }
    await assert.rejects(client.evaluate(messages, meta), error => {
      assert.ok(error instanceof AIGuardClientError)
      assert.equal(error.message, 'AI Guard service call failed, status 503')
      assert.equal(error.telemetryType, TAGS.ERROR_TYPE_STATUS)
      assert.deepEqual(error.errors, errors)
      return true
    })
    assert.equal(received.length, 1)
  })

  it('reports invalid JSON as a client error', async () => {
    process.env.HTTPS_PROXY = proxyUrl
    respond = (req, res) => res.end('invalid JSON')
    await assert.rejects(client.evaluate(messages, meta), error => {
      assert.ok(error instanceof AIGuardClientError)
      assert.equal(error.telemetryType, TAGS.ERROR_TYPE_CLIENT)
      assert.ok(error.cause instanceof SyntaxError)
      return true
    })
  })

  it('reports a rejected proxy connection without retrying or falling back to direct traffic', async () => {
    process.env.HTTPS_PROXY = proxyUrl
    rejectConnect = true
    await assert.rejects(client.evaluate(messages, meta), { name: 'AIGuardClientError' })
    assert.equal(connects.length, 1)
    assert.equal(received.length, 0)
  })

  for (const partialBody of [false, true]) {
    const phase = partialBody ? 'during the response body' : 'before response headers'
    it(`aborts a timed out evaluation ${phase}`, async () => {
      process.env.HTTPS_PROXY = proxyUrl
      const controller = new AbortController()
      const timeout = sinon.stub(AbortSignal, 'timeout').returns(controller.signal)
      respond = (req, res) => {
        if (partialBody) {
          res.writeHead(200)
          res.write('{')
        }
        controller.abort(new Error('Evaluation deadline exceeded'))
      }
      await assert.rejects(client.evaluate(messages, meta), error => {
        assert.ok(error instanceof AIGuardClientError)
        assert.equal(error.telemetryType, TAGS.ERROR_TYPE_CLIENT)
        return true
      })
      sinon.assert.calledOnceWithExactly(timeout, 1000)
      assert.equal(received.length, 1)
    })
  }
})
