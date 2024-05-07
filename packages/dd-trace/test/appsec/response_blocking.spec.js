'use strict'

const { assert } = require('chai')
const getPort = require('get-port')
const agent = require('../plugins/agent')
const Axios = require('axios')
const appsec = require('../../src/appsec')
const Config = require('../../src/config')
const path = require('path')
const blockingResponse = JSON.parse(require('../../src/appsec/blocked_templates').json)

describe.only('HTTP Response Blocking', () => {
  let server
  let responseHandler
  let axios

  before(async () => {
    const port = await getPort()

    await agent.load('http')

    const http = require('http')

    server = new http.Server((req, res) => {
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

  afterEach(() => {
    responseHandler = null
  })

  after(() => {
    appsec.disable()
    server?.close()
    return agent.close({ ritmReset: false })
  })

  it('should not block with no attack', async () => {
    responseHandler = (req, res) => {
      res.setHeaders(new Map(Object.entries({ a: 'good', b: 'good' })))
      res.setHeader('c', 'good')
      res.writeHead(200, { d: 'good' })
      res.flushHeaders()
      res.end('end')
    }
  })

  it('should block with implicit statusCode and setHeader()', async () => {
    responseHandler = (req, res) => {
      res.statusCode = 404
      res.setHeader('k', '404')
      res.end('end')
    }

    const res = await axios.get('/')

    assertBlocked(res)
  })

  it('should block with setHeader() and setHeaders() and writeHead() headers', async () => {
    responseHandler = (req, res) => {
      res.setHeaders(new Map(Object.entries({ a: 'bad1', b: 'good' })))
      res.setHeader('c', 'bad2')
      res.writeHead(200, { d: 'bad3' })
      res.end('end')
    }

    const res = await axios.get('/')

    assertBlocked(res)
  })

  it('should block with setHeader() and array writeHead() ', async () => {
    responseHandler = (req, res) => {
      res.setHeader('a', 'bad1')
      res.writeHead(200, 'OK', ['b', 'bad2', 'c', 'bad3'])
      res.end('end')
    }

    const res = await axios.get('/')

    assertBlocked(res)
  })

  it('should block with implicity statusCode, setHeader(), and flushHeaders()', async () => {
    responseHandler = (req, res) => {
      res.statusCode = 404
      res.setHeader('k', '404')
      res.flushHeaders()
      res.end('end')
    }

    const res = await axios.get('/')

    assertBlocked(res)
  })
})

function assertBlocked (res) {
  assert.equal(res.status, 403)
  assert.hasAllKeys(res.headers, [
    'content-type',
    'content-length',
    'date',
    'connection',
    'keep-alive'
  ])
  assert.deepEqual(res.data, blockingResponse)
}
