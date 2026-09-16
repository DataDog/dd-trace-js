'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')

const httpClient = require('./http-client')

describe('http-client test helper', () => {
  let server
  let baseURL

  before((done) => {
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        if (req.url === '/json') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, body: body ? JSON.parse(body) : undefined }))
        } else if (req.url === '/text') {
          res.writeHead(200, { 'Content-Type': 'text/plain' })
          res.end('hello')
        } else if (req.url === '/number-as-text') {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('3')
        } else if (req.url === '/binary') {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
          res.end(Buffer.from([1, 2, 3]))
        } else if (req.url === '/redirect') {
          res.writeHead(302, { Location: '/text' })
          res.end()
        } else if (req.url === '/not-found') {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'nope' }))
        } else if (req.url === '/echo-headers') {
          res.writeHead(200, { 'Content-Type': 'application/json', 'x-custom': 'yes' })
          res.end(JSON.stringify(req.headers))
        } else {
          res.writeHead(404)
          res.end()
        }
      })
    })
    server.listen(0, () => {
      baseURL = `http://localhost:${server.address().port}`
      done()
    })
  })

  after((done) => {
    server.close(done)
  })

  it('throws on a non-2xx response by default, with .response attached', async () => {
    await assert.rejects(
      () => httpClient.get(`${baseURL}/not-found`),
      (err) => {
        assert.equal(err.response.status, 404)
        assert.deepEqual(err.response.data, { error: 'nope' })
        return true
      }
    )
  })

  it('resolves instead of throwing when validateStatus permits the status', async () => {
    const res = await httpClient.get(`${baseURL}/not-found`, { validateStatus: () => true })
    assert.equal(res.status, 404)
    assert.deepEqual(res.data, { error: 'nope' })
  })

  it('never rejects when validateStatus is explicitly null, unlike an unspecified validateStatus', async () => {
    const res = await httpClient.get(`${baseURL}/not-found`, { validateStatus: null })
    assert.equal(res.status, 404)
  })

  it('supports .create() with a baseURL and merged defaults', async () => {
    const instance = httpClient.create({ baseURL, validateStatus: () => true })
    const res = await instance.get('/not-found')
    assert.equal(res.status, 404)
  })

  it('auto-serializes a plain object request body as JSON and auto-parses a JSON response', async () => {
    const res = await httpClient.post(`${baseURL}/json`, { hello: 'world' })
    assert.equal(res.status, 200)
    assert.deepEqual(res.data, { ok: true, body: { hello: 'world' } })
  })

  it('returns non-JSON text bodies as-is', async () => {
    const res = await httpClient.get(`${baseURL}/text`)
    assert.equal(res.data, 'hello')
  })

  it('parses a JSON-shaped body even when Content-Type is not JSON, matching axios', async () => {
    const res = await httpClient.get(`${baseURL}/number-as-text`)
    assert.equal(res.data, 3)
    assert.equal(typeof res.data, 'number')
  })

  it('supports responseType: text', async () => {
    const res = await httpClient.get(`${baseURL}/json`, { responseType: 'text' })
    assert.equal(typeof res.data, 'string')
    assert.equal(JSON.parse(res.data).ok, true)
  })

  it('supports responseType: arraybuffer', async () => {
    const res = await httpClient.get(`${baseURL}/binary`, { responseType: 'arraybuffer' })
    assert.ok(res.data instanceof ArrayBuffer)
    assert.deepEqual([...new Uint8Array(res.data)], [1, 2, 3])
  })

  it('supports responseType: stream', async () => {
    const res = await httpClient.get(`${baseURL}/text`, { responseType: 'stream' })
    const chunks = []
    for await (const chunk of res.data) chunks.push(chunk)
    assert.equal(Buffer.concat(chunks).toString(), 'hello')
  })

  it('supports maxRedirects: 0 via redirect: manual', async () => {
    const res = await httpClient.get(`${baseURL}/redirect`, { validateStatus: () => true, maxRedirects: 0 })
    assert.equal(res.status, 302)
  })

  it('exposes response headers as a plain lowercase-keyed object', async () => {
    const res = await httpClient.get(`${baseURL}/echo-headers`)
    assert.equal(res.headers['x-custom'], 'yes')
    assert.equal(res.headers['content-type'], 'application/json')
  })

  it('forwards request headers', async () => {
    const res = await httpClient.get(`${baseURL}/echo-headers`, { headers: { 'x-request-id': 'abc' } })
    assert.equal(res.data['x-request-id'], 'abc')
  })

  it('supports auth: { username, password } as a Basic Authorization header', async () => {
    const res = await httpClient.get(`${baseURL}/echo-headers`, { auth: { username: 'user', password: 'pass' } })
    const expected = `Basic ${Buffer.from('user:pass').toString('base64')}`
    assert.equal(res.data.authorization, expected)
  })
})
