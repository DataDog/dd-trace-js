'use strict'

const assert = require('node:assert/strict')

const {
  ClientRequestInterceptor,
} = require('@mswjs/interceptors/lib/interceptors/ClientRequest')

const request = require('dd-trace/packages/dd-trace/src/exporters/common/request')

const interceptor = new ClientRequestInterceptor()

interceptor.on('request', interceptedRequest => {
  interceptedRequest.respondWith({
    status: 200,
    body: 'OK',
  })
})
interceptor.apply()

request(Buffer.from(''), {
  url: new URL('https://intake.example/path'),
  method: 'POST',
  headers: {
    'DD-API-KEY': 'test-api-key',
  },
  retry: false,
}, (error, body, statusCode) => {
  try {
    assert.ifError(error)
    assert.strictEqual(body, 'OK')
    assert.strictEqual(statusCode, 200)
  } finally {
    interceptor.dispose()
  }
})
