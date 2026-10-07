'use strict'

const assert = require('node:assert/strict')
const { Readable } = require('node:stream')

const { after, before, describe, it } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')
const { callViaCallback, setup, withAwsSdkVersions } = require('./spec_helpers')

const bodyContent = 'payload-tagging-body-content'
const bucketName = 's3-payload-tagging-test'
const failingBucketName = 's3-payload-tagging-capture-failure'

// The pinned LocalStack community images (3.0.2 and 1.1.0) have no working
// HTTP state-reset endpoint: `POST /reset` answers 200 but leaves S3 state
// untouched, and `POST /_localstack/state/reset` is 404 because the state
// reset API is Pro only. Suites therefore reset state through the S3 API
// itself, and cleanup failures surface instead of being swallowed.

/**
 * Delete every object in `bucket` and then the bucket itself.
 *
 * @param {object} s3 S3 client (v2 service instance or v3 aggregated client).
 * @param {string} bucket Bucket name.
 * @param {{ tolerateMissing?: boolean }} [opts] When true, a missing bucket is
 *   treated as already clean so fresh LocalStack instances need no special case.
 * @returns {Promise<void>}
 */
async function drainBucket (s3, bucket, { tolerateMissing = false } = {}) {
  try {
    const listed = await callViaCallback(s3, 'listObjects', { Bucket: bucket })
    const contents = (listed && listed.Contents) || []
    if (contents.length > 0) {
      await callViaCallback(s3, 'deleteObjects', {
        Bucket: bucket,
        Delete: { Objects: contents.map(({ Key }) => ({ Key })) },
      })
    }
    await callViaCallback(s3, 'deleteBucket', { Bucket: bucket })
  } catch (err) {
    const name = err.name || err.code
    if (tolerateMissing && name === 'NoSuchBucket') return
    throw err
  }
}

/**
 * Run `reset`, then always run `close`. If both fail, the close error is
 * rethrown with the reset error attached so neither failure is lost.
 *
 * @param {() => Promise<void>} reset Fixture cleanup step.
 * @param {() => Promise<void>} close Agent teardown step.
 * @returns {Promise<void>}
 */
async function cleanup (reset, close) {
  let resetError
  try {
    await reset()
  } catch (err) {
    resetError = err
  }
  try {
    await close()
  } catch (closeError) {
    if (resetError) {
      closeError.resetError = resetError
    }
    throw closeError
  }
  if (resetError) {
    throw resetError
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
  describe('aws-sdk (s3 payload tagging) cleanup helpers', () => {
    it('surfaces reset failures instead of swallowing them', async () => {
      const reset = async () => {
        throw new Error('reset failed')
      }
      await assert.rejects(cleanup(reset, async () => {}), { message: 'reset failed' })
    })

    it('closes the agent even when reset fails', async () => {
      let closed = false
      const reset = async () => {
        throw new Error('reset failed')
      }
      const close = async () => {
        closed = true
      }
      await assert.rejects(cleanup(reset, close), { message: 'reset failed' })
      assert.strictEqual(closed, true)
    })

    it('preserves both errors when reset and close fail', async () => {
      const reset = async () => {
        throw new Error('reset failed')
      }
      const close = async () => {
        throw new Error('close failed')
      }
      await assert.rejects(cleanup(reset, close), /** @param {Error & { resetError?: Error }} err */ err => {
        assert.strictEqual(err.message, 'close failed')
        assert.ok(err.resetError)
        assert.strictEqual(err.resetError.message, 'reset failed')
        return true
      })
    })
  })

  describe('aws-sdk (s3 payload tagging)', function () {
    setup()
    this.timeout(30000)

    withAwsSdkVersions((version, moduleName) => {
      const isV3 = moduleName === '@aws-sdk/smithy-client'
      const s3ClientName = isV3 ? '@aws-sdk/client-s3' : 'aws-sdk'

      let s3

      describe('with payload tagging enabled', () => {
        before(() => {
          return agent.load('aws-sdk', {}, {
            cloudPayloadTagging: {
              // 'all' keeps the default service redaction rules while letting
              // assertions inspect the original Bucket and ETag values.
              request: 'all',
              response: 'all',
              maxDepth: 10,
            },
          })
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
          // Fix for LocationConstraint issue - only for SDK v2 (same as s3.spec.js).
          if (!isV3) {
            s3.api.globalEndpoint = '127.0.0.1'
          }

          await drainBucket(s3, bucketName, { tolerateMissing: true })
          await callViaCallback(s3, 'createBucket', { Bucket: bucketName })
          await callViaCallback(s3, 'putObject', { Bucket: bucketName, Key: 'streaming-body', Body: bodyContent })
        })

        after(async () => {
          await cleanup(
            () => (s3 ? drainBucket(s3, bucketName) : Promise.resolve()),
            () => agent.close()
          )
        })

        if (isV3) {
          it('exports S3 spans with truncated stream response tags on repeated GetObject calls', async () => {
            const params = { Bucket: bucketName, Key: 'streaming-body' }

            const firstSpanPromise = agent.assertFirstTraceSpan(span => {
              assert.strictEqual(span.meta['aws.request.body.Bucket'], bucketName)
              assert.ok(span.meta['aws.response.body.ETag'])
              assert.strictEqual(span.meta['aws.response.body.Body'], 'truncated')
              assert.ok(!hasStreamInternals(span.meta))
            }, { timeoutMs: 20000, spanResourceMatch: new RegExp(`^getObject ${bucketName}$`) })

            await Promise.all([
              callViaCallback(s3, 'getObject', params).then(async data => {
                assert.strictEqual(await readBody(data.Body), bodyContent)
              }),
              firstSpanPromise,
            ])

            const secondSpanPromise = agent.assertFirstTraceSpan(span => {
              assert.ok(span.meta['aws.response.body.ETag'])
              assert.strictEqual(span.meta['aws.response.body.Body'], 'truncated')
            }, { timeoutMs: 20000, spanResourceMatch: new RegExp(`^getObject ${bucketName}$`) })

            await Promise.all([
              callViaCallback(s3, 'getObject', params).then(data => readBody(data.Body)),
              secondSpanPromise,
            ])
          })

          it('truncates streaming request bodies without consuming them', async () => {
            const stream = Readable.from([Buffer.from(bodyContent)])

            const requestSpanPromise = agent.assertFirstTraceSpan(span => {
              assert.strictEqual(span.meta['aws.request.body.Bucket'], bucketName)
              assert.strictEqual(span.meta['aws.request.body.Body'], 'truncated')
              assert.ok(!hasStreamInternals(span.meta))
            }, { timeoutMs: 20000, spanResourceMatch: new RegExp(`^putObject ${bucketName}$`) })

            await Promise.all([
              callViaCallback(s3, 'putObject', {
                Bucket: bucketName,
                Key: 'streaming-request',
                Body: stream,
                // The SDK rejects a stream body without a known length.
                ContentLength: Buffer.byteLength(bodyContent),
              }),
              requestSpanPromise,
            ])

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
              assert.strictEqual(span.meta['aws.response.body.Body'], bodyContent)
              assert.ok(span.meta['aws.response.body.ETag'])
              assert.ok(!hasStreamInternals(span.meta))
            }, { timeoutMs: 20000, spanResourceMatch: new RegExp(`^getObject ${bucketName}$`) })

            await Promise.all([
              callViaCallback(s3, 'getObject', {
                Bucket: bucketName,
                Key: 'buffered-body',
              }).then(async data => {
                assert.strictEqual(data.Body.toString(), bodyContent)
              }),
              spanPromise,
            ])
          })
        }
      })

      describe('with a failing redaction rule', () => {
        before(() => {
          return agent.load('aws-sdk', {}, {
            cloudPayloadTagging: {
              // A filter that dereferences a missing nested value throws inside
              // the vendored JSONPath implementation for any object payload,
              // which exercises the fail-soft path through valid SDK input.
              request: '$[?(@.missing.child)]',
              response: 'all',
              maxDepth: 10,
            },
          })
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
          // Fix for LocationConstraint issue - only for SDK v2 (same as s3.spec.js).
          if (!isV3) {
            s3.api.globalEndpoint = '127.0.0.1'
          }

          await drainBucket(s3, failingBucketName, { tolerateMissing: true })
          await callViaCallback(s3, 'createBucket', { Bucket: failingBucketName })
        })

        after(async () => {
          await cleanup(
            () => (s3 ? drainBucket(s3, failingBucketName) : Promise.resolve()),
            () => agent.close()
          )
        })

        it('omits request payload tags without breaking the operation when a redaction rule throws', async () => {
          const spanPromise = agent.assertFirstTraceSpan(span => {
            assert.ok(!Object.keys(span.meta).some(key => key.startsWith('aws.request.body')))
            // The operation itself must not be marked as failed.
            assert.strictEqual(span.meta.error, undefined)
            // Response tagging is unaffected by the request-tagging failure.
            assert.ok(span.meta['aws.response.body.ETag'])
          }, { timeoutMs: 20000, spanResourceMatch: new RegExp(`^putObject ${failingBucketName}$`) })

          await Promise.all([
            callViaCallback(s3, 'putObject', {
              Bucket: failingBucketName,
              Key: 'capture-failure',
              Body: bodyContent,
            }),
            spanPromise,
          ])

          // the plugin must remain enabled and tracing must continue normally
          const nextSpanPromise = agent.assertFirstTraceSpan(span => {
            assert.strictEqual(span.meta.error, undefined)
          }, { timeoutMs: 20000, spanResourceMatch: new RegExp(`^getObject ${failingBucketName}$`) })

          await Promise.all([
            callViaCallback(s3, 'getObject', {
              Bucket: failingBucketName,
              Key: 'capture-failure',
            }).then(async data => {
              assert.strictEqual(await readBody(data.Body), bodyContent)
            }),
            nextSpanPromise,
          ])
        })
      })
    })
  })
})
