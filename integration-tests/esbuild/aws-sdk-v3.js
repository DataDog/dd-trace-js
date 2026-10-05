'use strict'

const assert = require('node:assert/strict')

require('../../').init() // dd-trace

const dc = require('dc-polyfill')
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs')

// `@aws-sdk/client-*` >= 3.1046.0 extends `@smithy/core/client`, which is hooked
// through its `dist-cjs` file. The client must construct and the hook must
// still fire from the bundle (see issue #10605).
const client = new SQSClient({
  region: 'us-east-1',
  endpoint: 'http://127.0.0.1:1',
  maxAttempts: 1,
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
})

let request

dc.channel('apm:aws:request:start:sqs').subscribe((ctx) => {
  request = ctx.request
})

client.send(new SendMessageCommand({ QueueUrl: 'http://127.0.0.1:1/queue', MessageBody: 'test' }))
  .catch(() => {}) // the endpoint is unreachable on purpose
  .then(() => {
    assert.ok(request, 'Client.send from @smithy/core/client was not instrumented')
    assert.strictEqual(request.params.MessageBody, 'test')
  })
