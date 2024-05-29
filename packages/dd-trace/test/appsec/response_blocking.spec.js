'use strict'

const { assert } = require('chai')
const getPort = require('get-port')
const agent = require('../plugins/agent')
const Axios = require('axios')
const appsec = require('../../src/appsec')
const Config = require('../../src/config')
const path = require('path')
const WafContext = require('../../src/appsec/waf/waf_context_wrapper')
const blockingResponse = JSON.parse(require('../../src/appsec/blocked_templates').json)
const fs = require('fs')

describe('HTTP Response Blocking', () => {
  let server
  let responseHandler
  let axios

  before(async () => {
    const port = await getPort()

    await agent.load('http')

    const http = require('http')

    server = new http.Server((req, res) => {
      // little polyfill, older versions of node don't have setHeaders()
      if (typeof res.setHeaders !== 'function') {
        res.setHeaders = headers => headers.forEach((v, k) => res.setHeader(k, v))
      }

      if (responseHandler) {
        responseHandler(req, res)
      } else {
        res.writeHead(200)
        res.end('OK')
      }
    })

    await new Promise((resolve, reject) => {
      server.listen(port, 'localhost')
        .once('listening', resolve)
        .once('error', reject)
    })

    axios = Axios.create(({
      baseURL: `http://localhost:${port}`,
      validateStatus: null
    }))

    appsec.enable(new Config({
      appsec: {
        enabled: true,
        rules: path.join(__dirname, 'response_blocking_rules.json')
      }
    }))
  })

  beforeEach(() => {
    sinon.spy(WafContext.prototype, 'run')
  })

  afterEach(() => {
    sinon.restore()
    responseHandler = null
  })

  after(() => {
    appsec.disable()
    server?.close()
    return agent.close({ ritmReset: false })
  })

  it('should block with implicit statusCode + setHeader() + end()', async () => {
    responseHandler = (req, res) => {
      res.statusCode = 404
      res.setHeader('k', '404')
      res.end('end')
    }

    const res = await axios.get('/')

    assertBlocked(res)
  })

  it('should block with setHeader() + setHeaders() + writeHead() headers', async () => {
    responseHandler = (req, res) => {
      res.setHeaders(new Map(Object.entries({ a: 'bad1', b: 'good' })))
      res.setHeader('c', 'bad2')
      res.writeHead(200, { d: 'bad3' })
      res.end('end')
    }

    const res = await axios.get('/')

    assertBlocked(res)
  })

  it('should block with setHeader() + array writeHead() ', async () => {
    responseHandler = (req, res) => {
      res.setHeader('a', 'bad1')
      res.writeHead(200, 'OK', ['b', 'bad2', 'c', 'bad3'])
      res.end('end')
    }

    const res = await axios.get('/')

    assertBlocked(res)
  })

  it('should not block with array writeHead() when attack is in the header name and not in header value', async () => {
    responseHandler = (req, res) => {
      res.writeHead(200, 'OK', ['a', 'bad1', 'b', 'bad2', 'bad3', 'c'])
      res.end('end')
    }

    const res = await axios.get('/')

    assert.equal(res.status, 200)
    assert.hasAllKeys(cloneHeaders(res.headers), [
      'a',
      'b',
      'bad3',
      'date',
      'connection',
      'transfer-encoding'
    ])
    assert.deepEqual(res.data, 'end')
  })

  it('should block with implicit statusCode + setHeader() + flushHeaders()', async () => {
    responseHandler = (req, res) => {
      res.statusCode = 404
      res.setHeader('k', '404')
      res.flushHeaders()
      res.end('end')
    }

    const res = await axios.get('/')

    assertBlocked(res)
  })

  it('should block with implicit statusCode + setHeader() + write()', async () => {
    responseHandler = (req, res) => {
      res.statusCode = 404
      res.setHeader('k', '404')
      res.write('write')
      res.end('end')
    }

    const res = await axios.get('/')

    assertBlocked(res)
  })

  it('should block with implicit statusCode + setHeader() + stream pipe', async () => {
    responseHandler = (req, res) => {
      res.statusCode = 404
      res.setHeader('k', '404')
      streamFile(res)
    }

    const res = await axios.get('/')

    assertBlocked(res)
  })

  it('should block with writeHead() + write()', async () => {
    responseHandler = (req, res) => {
      res.writeHead(404, { k: '404' })
      res.write('write')
      res.end('end')
    }

    const res = await axios.get('/')

    assertBlocked(res)
  })

  it('should block with every methods combined', async () => {
    responseHandler = (req, res) => {
      res.setHeaders(new Map(Object.entries({ a: 'bad1', b: 'good' })))
      res.setHeader('c', 'bad2')
      res.setHeader('d', 'good')
      res.writeHead(200, 'OK', { d: 'good', e: 'bad3' })
      res.flushHeaders()
      res.write('write')
      res.addTrailers({ k: 'v' })
      streamFile(res)
    }

    const res = await axios.get('/')

    assertBlocked(res)
  })

  it('should not block with every methods combined but no attack', async () => {
    responseHandler = (req, res) => {
      res.setHeaders(new Map(Object.entries({ a: 'good', b: 'good' })))
      res.setHeader('c', 'good')
      res.setHeader('d', 'good')
      res.writeHead(201, 'OK', { d: 'good', e: 'good' })
      res.flushHeaders()
      res.write('write')
      res.addTrailers({ k: 'v' })
      streamFile(res)
    }

    const res = await axios.get('/')

    assert.equal(res.status, 201)
    assert.hasAllKeys(cloneHeaders(res.headers), [
      'a',
      'b',
      'c',
      'd',
      'e',
      'date',
      'connection',
      'transfer-encoding'
    ])
    assert.deepEqual(res.data, 'writefileend')
  })

  it('should ignore subsequent response writes after blocking', async () => {
    responseHandler = (req, res) => {
      res.statusCode = 404
      res.setHeader('k', '404')
      res.flushHeaders()
      res.writeHead(200, { k: '200' })
      res.write('write1')
      setTimeout(() => {
        res.write('write2')
        res.end('end')
      }, 1000)
    }

    const res = await axios.get('/')

    assertBlocked(res)
  })
})

function cloneHeaders (headers) {
  // clone the headers accessor to a flat object
  // and delete the keep-alive header as it's not always present
  headers = Object.fromEntries(Object.entries(headers))
  delete headers['keep-alive']

  return headers
}

function assertBlocked (res) {
  assert.equal(res.status, 403)
  assert.hasAllKeys(cloneHeaders(res.headers), [
    'content-type',
    'content-length',
    'date',
    'connection'
  ])
  assert.deepEqual(res.data, blockingResponse)

  sinon.assert.callCount(WafContext.prototype.run, 2)
}

function streamFile (res) {
  const stream = fs.createReadStream(path.join(__dirname, '/streamtest.txt'), { encoding: 'utf8' })
  stream.pipe(res, { end: false })
  stream.on('end', () => res.end('end'))
}
