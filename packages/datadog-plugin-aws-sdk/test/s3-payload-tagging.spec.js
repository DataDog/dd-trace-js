'use strict'

const assert = require('node:assert/strict')
const { Readable } = require('node:stream')

const axios = require('axios')
const { after, before, describe, it } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')
const { callViaCallback, setup, withAwsSdkVersions } = require('./spec_helpers')

const bodyContent = 'payload-tagging-body-content'

async function resetLocalStackS3 () {
  try {
    await axios.post('http://localhost:4566/reset')
  } catch {
    // LocalStack not running: plugin tests will fail on the AWS calls below.
  }
}

// SDK v3 returns the body as a stream mixin (transformToString); SDK v2 as a Buffer.
async function readBody (body) {
  if (typeof body.transformToString === 'function') {
    return body.transformToString()
  }
  return body.toString()
}

function hasStreamInternals (meta) {
  return Object.keys(meta).some(key => /_readableState|_events|socket/i.test(key))
}

describe('Plugin', () => {
  describe('aws-sdk (s3 payload tagging)', function () {
    setup()
    this.timeout(30000)

    withAwsSdkVersions((version, moduleName) => {
      const isV3 = moduleName === '@aws-sdk/smithy-client'
      const s3ClientName = isV3 ? '@aws-sdk/client-s3' : 'aws-sdk'
      const bucketName = 's3-payload-tagging-test'

      let s3

      describe('with payload tagging enabled', () => {
        before(() => {
          return agent.load('aws-sdk', {}, {
            cloudPayloadTagging: {
              request: '$.Bucket',
              response: '$.ETag',
              maxDepth: 10,
            },
          })
        })

        after(async () => {
          await resetLocalStackS3()
          return agent.close()
        })

        before(async () => {
          const AWS = require(`../../../versions/${s3ClientName}@${version}`).get()
          const options = { endpoint: 'http://127.0.0.1:4566', region: 'us-east-1' }
          if (isV3) {
            options.forcePathStyle = true
          } else {
            options.s3ForcePathStyle = true
          }
          s3 = new AWS.S3(options)

          await resetLocalStackS3()
          await callViaCallback(s3, 'createBucket', { Bucket: bucketName })
          await callViaCallback(s3, 'putObject', { Bucket: bucketName, Key: 'streaming-body', Body: bodyContent })
        })

        if (isV3) {
          it('exports S3 spans with truncated stream response tags on repeated GetObject calls', async () => {
            const params = { Bucket: bucketName, Key: 'streaming-body' }

            const firstSpanPromise = agent.assertFirstTraceSpan(span => {
              assert.strictEqual(span.resource, `getObject ${bucketName}`)
              assert.strictEqual(span.meta['aws.request.body.Bucket'], bucketName)
              assert.ok(span.meta['aws.response.body.ETag'])
              assert.strictEqual(span.meta['aws.response.body.Body'], 'truncated')
              assert.ok(!hasStreamInternals(span.meta))
            }, { timeoutMs: 20000 })

            const data = await callViaCallback(s3, 'getObject', params)
            assert.strictEqual(await readBody(data.Body), bodyContent)

            await firstSpanPromise

            const secondSpanPromise = agent.assertFirstTraceSpan(span => {
              assert.strictEqual(span.resource, `getObject ${bucketName}`)
              assert.ok(span.meta['aws.response.body.ETag'])
              assert.strictEqual(span.meta['aws.response.body.Body'], 'truncated')
            }, { timeoutMs: 20000 })

            await callViaCallback(s3, 'getObject', params)
            await secondSpanPromise
          })

          it('truncates streaming request bodies without consuming them', async () => {
            const stream = Readable.from([Buffer.from(bodyContent)])

            const requestSpanPromise = agent.assertFirstTraceSpan(span => {
              assert.strictEqual(span.resource, `putObject ${bucketName}`)
              assert.strictEqual(span.meta['aws.request.body.Bucket'], bucketName)
              assert.strictEqual(span.meta['aws.request.body.Body'], 'truncated')
              assert.ok(!hasStreamInternals(span.meta))
            }, { timeoutMs: 20000 })

            await callViaCallback(s3, 'putObject', {
              Bucket: bucketName,
              Key: 'streaming-request',
              Body: stream,
            })
            await requestSpanPromise

            const data = await callViaCallback(s3, 'getObject', {
              Bucket: bucketName,
              Key: 'streaming-request',
            })
            assert.strictEqual(await readBody(data.Body), bodyContent)
          })
        } else {
          it('retains buffered response body content as payload tags', async () => {
            await callViaCallback(s3, 'putObject', {
              Bucket: bucketName,
              Key: 'buffered-body',
              Body: bodyContent,
            })

            const spanPromise = agent.assertFirstTraceSpan(span => {
              assert.strictEqual(span.resource, `getObject ${bucketName}`)
              assert.strictEqual(span.meta['aws.response.body.Body'], bodyContent)
              assert.ok(span.meta['aws.response.body.ETag'])
              assert.ok(!hasStreamInternals(span.meta))
            }, { timeoutMs: 20000 })

            const data = await callViaCallback(s3, 'getObject', {
              Bucket: bucketName,
              Key: 'buffered-body',
            })
            assert.strictEqual(data.Body.toString(), bodyContent)

            await spanPromise
          })
        }

        it('omits payload tags without breaking the operation when capture fails', async () => {
          const params = { Bucket: bucketName, Key: 'fail-soft', Body: bodyContent }
          Object.defineProperty(params, 'trap', {
            get () {
              throw new Error('trap')
            },
            enumerable: true,
          })

          const failedCaptureSpanPromise = agent.assertFirstTraceSpan(span => {
            assert.strictEqual(span.resource, `putObject ${bucketName}`)
            assert.ok(!Object.keys(span.meta).some(key => key.startsWith('aws.request.body')))
          }, { timeoutMs: 20000 })

          await callViaCallback(s3, 'putObject', params)
          await failedCaptureSpanPromise

          // the plugin must remain enabled and tracing must continue normally
          const nextSpanPromise = agent.assertFirstTraceSpan({
            resource: `getObject ${bucketName}`,
          }, { timeoutMs: 20000 })
          await callViaCallback(s3, 'getObject', { Bucket: bucketName, Key: 'fail-soft' })
          await nextSpanPromise
        })
      })
    })
  })
})
