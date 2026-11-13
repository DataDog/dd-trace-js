'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const http = require('node:http')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { DataStreamsProcessor } = require('../../dd-trace/src/datastreams/processor')
const agent = require('../../dd-trace/test/plugins/agent')
const { callViaCallback, setup, withAwsSdkVersions } = require('./spec_helpers')

const DSM_HEADER = 'dd-pathway-ctx-base64'

describe('Plugin', () => {
  describe('aws-sdk (sqs) data streams over http', function () {
    this.timeout(10000)
    setup()

    withAwsSdkVersions((version, moduleName) => {
      const sqsClientName = moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-sqs' : 'aws-sdk'

      let server
      let received
      let sqs
      let recordCheckpoint

      before(async () => {
        process.env.DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED = 'false'
        await agent.load(['aws-sdk', 'http'], [{ sqs: { dsmEnabled: true } }, { server: false }])

        server = http.createServer((req, res) => {
          received.push(req.headers)
          req.resume()
          res.writeHead(400, { 'content-type': 'text/xml' })
          res.end('<ErrorResponse><Error><Code>Fake</Code><Message>fake</Message></Error></ErrorResponse>')
        })
        server.listen(0, '127.0.0.1')
        await once(server, 'listening')

        const AWS = require(`../../../versions/${sqsClientName}@${version}`).get()
        sqs = new AWS.SQS({
          endpoint: `http://127.0.0.1:${server.address().port}`,
          region: 'us-east-1',
          maxRetries: 0,
          maxAttempts: 1,
        })
      })

      after(async () => {
        delete process.env.DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED
        // SDK v3 keeps its connection open, and before Node.js 19 server.close() waits for it.
        server.closeAllConnections()
        await Promise.all([agent.close(), new Promise(resolve => server.close(resolve))])
      })

      beforeEach(() => {
        received = []
        recordCheckpoint = sinon.spy(DataStreamsProcessor.prototype, 'recordCheckpoint')
      })

      afterEach(() => {
        recordCheckpoint.restore()
      })

      it('records the queue checkpoint and no http checkpoint or pathway header', async () => {
        const QueueUrl = `http://127.0.0.1:${server.address().port}/000000000000/dsm-http`

        await callViaCallback(sqs, 'sendMessage', { QueueUrl, MessageBody: 'body' }).catch(() => {})

        const edges = recordCheckpoint.args.map(([checkpoint]) => checkpoint.edgeTags.join(','))
        assert.deepStrictEqual(edges, ['direction:out,topic:dsm-http,type:sqs'])
        assert.strictEqual(received.length, 1)
        assert.ok(received[0]['x-datadog-trace-id'], 'trace headers missing')
        assert.strictEqual(received[0][DSM_HEADER], undefined)
      })
    })
  })
})
