'use strict'

const assert = require('assert')

const axios = require('axios')
const { satisfies } = require('semver')
const msgpack = require('@msgpack/msgpack')

const agent = require('../plugins/agent')
const { NODE_MAJOR, NODE_MINOR, NODE_PATCH } = require('../../../../version')
const { withVersions } = require('../setup/mocha')
const { initApp, startServer } = require('./next.utils')
const { createDeepObject, getWebSpan } = require('./utils')

describe('extended data collection', () => {
  withVersions('next', 'next', '>=11.1', version => {
    if (version === '>=11.0.0 <13' && NODE_MAJOR === 24 &&
      NODE_MINOR === 0 && NODE_PATCH === 0) {
      // node 24.0.0 fails, but 24.0.1 works
    }

    const realVersion = require(`../../../../versions/next@${version}`).version()

    const tests = [
      {
        appName: 'pages-dir',
        serverPath: 'server'
      }
    ]

    if (satisfies(realVersion, '>=13.2') && (NODE_MAJOR < 24 || satisfies(realVersion, '!=13.2'))) {
      tests.push({
        appName: 'app-dir',
        serverPath: '.next/standalone/server.js'
      })
    }

    tests.forEach(({ appName, serverPath }) => {
      if (satisfies(realVersion, '>=16') && NODE_MAJOR < 20) {
        return
      }

      describe(`extended data collection in ${appName}`, () => {
        initApp(appName, version, realVersion)

        const serverData = startServer(appName, serverPath, version, 'datadog-extended-data-collection.js')

        it('Should collect nothing when no extended_data_collection is triggered', async () => {
          const requestBody = {
            other: 'other',
            chained: {
              child: 'one',
              child2: 2
            }
          }

          await axios.post(
            `http://127.0.0.1:${serverData.port}/api/extended-data-collection`,
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
            const span = getWebSpan(traces)

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
            `http://127.0.0.1:${serverData.port}/api/extended-data-collection/redacted-headers`,
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
            const span = getWebSpan(traces)

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
            `http://127.0.0.1:${serverData.port}/api/extended-data-collection`,
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
            const span = getWebSpan(traces)

            const collectedRequestHeaders = Object.keys(span.meta)
              .filter(metaKey => metaKey.startsWith('http.request.headers.')).length
            const collectedResponseHeaders = Object.keys(span.meta)
              .filter(metaKey => metaKey.startsWith('http.response.headers.')).length
            assert.strictEqual(collectedRequestHeaders, 8)
            assert.strictEqual(collectedResponseHeaders, 8)

            assert.ok(span.metrics['_dd.appsec.request.header_collection.discarded'] >= 2)
            assert.ok(span.metrics['_dd.appsec.response.header_collection.discarded'] >= 2)

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
          await axios.post(`http://127.0.0.1:${serverData.port}/api/extended-data-collection`, requestBody)

          await agent.assertSomeTraces((traces) => {
            const span = getWebSpan(traces)

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
          await axios.post(`http://127.0.0.1:${serverData.port}/api/extended-data-collection`, requestBody)

          await agent.assertSomeTraces((traces) => {
            const span = getWebSpan(traces)

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
          await axios.post(`http://127.0.0.1:${serverData.port}/api/extended-data-collection`, requestBody)

          await agent.assertSomeTraces((traces) => {
            const span = getWebSpan(traces)

            const metaStructBody = msgpack.decode(span.meta_struct['http.request.body'])
            assert.deepEqual(metaStructBody, expectedRequestBody)
          })
        })
      })
    })
  })
})
