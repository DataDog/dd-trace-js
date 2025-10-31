'use strict'

const Config = require('../../src/config')
const path = require('path')
const { withVersions } = require('../setup/mocha')
const agent = require('../plugins/agent')
const appsec = require('../../src/appsec')
const axios = require('axios')
const assert = require('assert')
const msgpack = require('@msgpack/msgpack')
const { createDeepObject } = require('./utils')

describe('extended data collection', () => {
  before(() => {
    return agent.load(['express', 'http'], { client: false })
  })

  after(() => {
    return agent.close({ ritmReset: false })
  })

  withVersions('express', 'express', expressVersion => {
    let port, server

    before((done) => {
      const express = require(`../../../../versions/express@${expressVersion}`).get()
      const bodyParser = require('../../../../versions/body-parser').get()

      const app = express()
      app.use(bodyParser.json())

      app.post('/', (req, res) => {
        res.setHeader('custom-response-header-1', 'custom-response-header-value-1')
        res.setHeader('custom-response-header-2', 'custom-response-header-value-2')
        res.setHeader('custom-response-header-3', 'custom-response-header-value-3')
        res.setHeader('custom-response-header-4', 'custom-response-header-value-4')
        res.setHeader('custom-response-header-5', 'custom-response-header-value-5')
        res.setHeader('custom-response-header-6', 'custom-response-header-value-6')
        res.setHeader('custom-response-header-7', 'custom-response-header-value-7')
        res.setHeader('custom-response-header-8', 'custom-response-header-value-8')
        res.setHeader('custom-response-header-9', 'custom-response-header-value-9')
        res.setHeader('custom-response-header-10', 'custom-response-header-value-10')

        res.end('DONE')
      })

      app.post('/redacted-headers', (req, res) => {
        res.setHeader('authorization', 'header-value-1')
        res.setHeader('proxy-authorization', 'header-value-2')
        res.setHeader('www-authenticate', 'header-value-4')
        res.setHeader('proxy-authenticate', 'header-value-5')
        res.setHeader('authentication-info', 'header-value-6')
        res.setHeader('proxy-authentication-info', 'header-value-7')
        res.setHeader('cookie', 'header-value-8')
        res.setHeader('set-cookie', 'header-value-9')

        res.end('DONE')
      })

      server = app.listen(port, () => {
        port = server.address().port
        done()
      })
    })

    after(() => {
      server.close()
    })

    beforeEach(() => {
      appsec.enable(new Config(
        {
          appsec: {
            enabled: true,
            rules: path.join(__dirname, './extended-data-collection.rules.json')
          }
        }
      ))
    })

    afterEach(() => {
      appsec.disable()
    })

    it('Should collect nothing when no extended_data_collection is triggered', async () => {
      const requestBody = {
        other: 'other',
        chained: {
          child: 'one',
          child2: 2
        }
      }
      await axios.post(
        `http://localhost:${port}/`,
        requestBody,
        {
          headers: {
            'custom-header-key-1': 'custom-header-value-1',
            'custom-header-key-2': 'custom-header-value-2',
            'custom-header-key-3': 'custom-header-value-3'
          }
        }
      )

      await agent.assertSomeTraces((traces) => {
        const span = traces[0][0]
        assert.strictEqual(span.type, 'web')

        assert.strictEqual(span.meta['http.request.headers.custom-request-header-1'], undefined)
        assert.strictEqual(span.meta['http.request.headers.custom-request-header-2'], undefined)
        assert.strictEqual(span.meta['http.request.headers.custom-request-header-3'], undefined)

        assert.strictEqual(span.meta['http.response.headers.custom-response-header-1'], undefined)
        assert.strictEqual(span.meta['http.response.headers.custom-response-header-2'], undefined)
        assert.strictEqual(span.meta['http.response.headers.custom-response-header-3'], undefined)

        const rawMetaStructBody = span.meta_struct?.['http.request.body']
        assert.strictEqual(rawMetaStructBody, undefined)
      })
    })

    it('Should redact request/response headers', async () => {
      const requestBody = {
        bodyParam: 'collect-standard'
      }
      await axios.post(
        `http://localhost:${port}/redacted-headers`,
        requestBody,
        {
          headers: {
            authorization: 'header-value-1',
            'proxy-authorization': 'header-value-2',
            'www-authenticate': 'header-value-3',
            'proxy-authenticate': 'header-value-4',
            'authentication-info': 'header-value-5',
            'proxy-authentication-info': 'header-value-6',
            cookie: 'header-value-7',
            'set-cookie': 'header-value-8'
          }
        }
      )

      await agent.assertSomeTraces((traces) => {
        const span = traces[0][0]
        assert.strictEqual(span.type, 'web')
        assert.strictEqual(span.meta['http.request.headers.authorization'], '<redacted>')
        assert.strictEqual(span.meta['http.request.headers.proxy-authorization'], '<redacted>')
        assert.strictEqual(span.meta['http.request.headers.www-authenticate'], '<redacted>')
        assert.strictEqual(span.meta['http.request.headers.proxy-authenticate'], '<redacted>')
        assert.strictEqual(span.meta['http.request.headers.authentication-info'], '<redacted>')
        assert.strictEqual(span.meta['http.request.headers.proxy-authentication-info'], '<redacted>')
        assert.strictEqual(span.meta['http.request.headers.cookie'], '<redacted>')
        assert.strictEqual(span.meta['http.request.headers.set-cookie'], '<redacted>')

        assert.strictEqual(span.meta['http.response.headers.authorization'], '<redacted>')
        assert.strictEqual(span.meta['http.response.headers.proxy-authorization'], '<redacted>')
        assert.strictEqual(span.meta['http.response.headers.www-authenticate'], '<redacted>')
        assert.strictEqual(span.meta['http.response.headers.proxy-authenticate'], '<redacted>')
        assert.strictEqual(span.meta['http.response.headers.authentication-info'], '<redacted>')
        assert.strictEqual(span.meta['http.response.headers.proxy-authentication-info'], '<redacted>')
        assert.strictEqual(span.meta['http.response.headers.cookie'], '<redacted>')
        assert.strictEqual(span.meta['http.response.headers.set-cookie'], '<redacted>')
      })
    })

    it('Should collect request body and request/response with a max of 8 headers', async () => {
      const requestBody = {
        bodyParam: 'collect-few-headers',
        other: 'other',
        chained: {
          child: 'one',
          child2: 2
        }
      }
      await axios.post(
        `http://localhost:${port}/`,
        requestBody,
        {
          headers: {
            'custom-request-header-1': 'custom-request-header-value-1',
            'custom-request-header-2': 'custom-request-header-value-2',
            'custom-request-header-3': 'custom-request-header-value-3',
            'custom-request-header-4': 'custom-request-header-value-4',
            'custom-request-header-5': 'custom-request-header-value-5',
            'custom-request-header-6': 'custom-request-header-value-6',
            'custom-request-header-7': 'custom-request-header-value-7',
            'custom-request-header-8': 'custom-request-header-value-8',
            'custom-request-header-9': 'custom-request-header-value-9',
            'custom-request-header-10': 'custom-request-header-value-10'
          }
        }
      )

      await agent.assertSomeTraces((traces) => {
        const span = traces[0][0]
        assert.strictEqual(span.type, 'web')
        const collectedRequestHeaders = Object.keys(span.meta)
          .filter(metaKey => metaKey.startsWith('http.request.headers.')).length
        const collectedResponseHeaders = Object.keys(span.meta)
          .filter(metaKey => metaKey.startsWith('http.response.headers.')).length
        assert.strictEqual(collectedRequestHeaders, 8)
        assert.strictEqual(collectedResponseHeaders, 8)

        assert.ok(span.metrics['_dd.appsec.request.header_collection.discarded'] > 2)
        assert.ok(span.metrics['_dd.appsec.response.header_collection.discarded'] > 2)

        const metaStructBody = msgpack.decode(span.meta_struct['http.request.body'])
        assert.deepEqual(metaStructBody, requestBody)
      })
    })

    it('Should truncate the request body when depth is more than 20 levels', async () => {
      const deepObject = createDeepObject('sheet')

      const requestBody = {
        bodyParam: 'collect-standard',
        deepObject
      }

      const expectedDeepTruncatedObject = createDeepObject({ 's-19': 's-19' }, 1, 18)
      const expectedRequestBody = {
        bodyParam: 'collect-standard',
        deepObject: expectedDeepTruncatedObject
      }
      await axios.post(`http://localhost:${port}/`, requestBody)

      await agent.assertSomeTraces((traces) => {
        const span = traces[0][0]
        assert.strictEqual(span.type, 'web')

        const metaStructBody = msgpack.decode(span.meta_struct['http.request.body'])
        assert.deepEqual(metaStructBody, expectedRequestBody)
      })
    })

    it('Should truncate the request body when string length is more than 4096 characters', async () => {
      const requestBody = {
        bodyParam: 'collect-standard',
        longValue: Array(5000).fill('A').join('')
      }

      const expectedRequestBody = {
        bodyParam: 'collect-standard',
        longValue: Array(4096).fill('A').join('')
      }
      await axios.post(`http://localhost:${port}/`, requestBody)

      await agent.assertSomeTraces((traces) => {
        const span = traces[0][0]
        assert.strictEqual(span.type, 'web')

        const metaStructBody = msgpack.decode(span.meta_struct['http.request.body'])
        assert.deepEqual(metaStructBody, expectedRequestBody)
      })
    })

    it('Should truncate the request body when a node has more than 256 elements', async () => {
      const children = Array(300).fill('item')
      const requestBody = {
        bodyParam: 'collect-standard',
        children
      }

      const expectedRequestBody = {
        bodyParam: 'collect-standard',
        children: children.slice(0, 256)
      }
      await axios.post(`http://localhost:${port}/`, requestBody)

      await agent.assertSomeTraces((traces) => {
        const span = traces[0][0]
        assert.strictEqual(span.type, 'web')

        const metaStructBody = msgpack.decode(span.meta_struct['http.request.body'])
        assert.deepEqual(metaStructBody, expectedRequestBody)
      })
    })
  })
})
