'use strict'

const assert = require('node:assert/strict')

const axios = require('axios')
const { after, before, describe, it } = require('mocha')

const { S3_PTR_KIND, SPAN_POINTER_DIRECTION } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { withNamingSchema, withPeerService } = require('../../dd-trace/test/setup/mocha')
const { assertObjectContains } = require('../../../integration-tests/helpers')
const { rawExpectedSchema } = require('./s3-naming')
const { callViaCallback, setup, withAwsSdkVersions } = require('./spec_helpers')

const bucketName = 's3-bucket-name-test'

/* eslint-disable no-console */
async function resetLocalStackS3 () {
  try {
    await axios.post('http://localhost:4566/reset')
    console.log('LocalStack S3 reset successful')
  } catch (error) {
    console.error('Error resetting LocalStack S3:', error.message)
  }
}

describe('Plugin', () => {
  describe('aws-sdk (s3)', function () {
    setup()

    withAwsSdkVersions((version, moduleName) => {
      let AWS
      let s3
      let tracer

      const s3ClientName = moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-s3' : 'aws-sdk'
      describe('with configuration', () => {
        before(() => {
          tracer = require('../../dd-trace')
          return agent.load('aws-sdk')
        })

        before(function (done) {
          this.timeout(10_000)
          AWS = require(`../../../versions/${s3ClientName}@${version}`).get()
          s3 = new AWS.S3({ endpoint: 'http://127.0.0.1:4566', s3ForcePathStyle: true, region: 'us-east-1' })

          // Fix for LocationConstraint issue - only for SDK v2
          if (s3ClientName === 'aws-sdk') {
            s3.api.globalEndpoint = '127.0.0.1'
          }

          s3.createBucket({ Bucket: bucketName }, (err) => {
            if (err) return done(err)
            done()
          })
        })

        after(async () => {
          await resetLocalStackS3()
          return agent.close()
        })

        withPeerService(
          () => tracer,
          'aws-sdk',
          (done) => s3.putObject({
            Bucket: bucketName,
            Key: 'test-key',
            Body: 'test body',
          }, done),
          bucketName, 'bucketname')

        withNamingSchema(
          (done) => s3.putObject({
            Bucket: bucketName,
            Key: 'test-key',
            Body: 'test body',
          }, (err) => err && done(err)),
          rawExpectedSchema.outbound
        )

        describe('span pointers', () => {
          it('should add span pointer for putObject operation', async () => {
            const tracePromise = agent.assertFirstTraceSpan(span => {
              const links = JSON.parse(span.meta?.['_dd.span_links'] || '[]')

              assert.strictEqual(links.length, 1)
              assert.deepStrictEqual(links[0].attributes, {
                'ptr.kind': S3_PTR_KIND,
                'ptr.dir': SPAN_POINTER_DIRECTION.DOWNSTREAM,
                'ptr.hash': '6d1a2fe194c6579187408f827f942be3',
                'link.kind': 'span-pointer',
              })
            }, { spanResourceMatch: /^putObject / })

            await Promise.all([
              tracePromise,
              callViaCallback(s3, 'putObject', {
                Bucket: bucketName,
                Key: 'test-key',
                Body: 'test body',
              }),
            ])
          })

          it('should add span pointer for copyObject operation', async () => {
            const tracePromise = agent.assertFirstTraceSpan(span => {
              const links = JSON.parse(span.meta?.['_dd.span_links'] || '[]')

              assert.strictEqual(links.length, 1)
              assert.deepStrictEqual(links[0].attributes, {
                'ptr.kind': S3_PTR_KIND,
                'ptr.dir': SPAN_POINTER_DIRECTION.DOWNSTREAM,
                'ptr.hash': '1542053ce6d393c424b1374bac1fc0c5',
                'link.kind': 'span-pointer',
              })
            }, { spanResourceMatch: /^copyObject / })

            await Promise.all([
              tracePromise,
              callViaCallback(s3, 'copyObject', {
                Bucket: bucketName,
                Key: 'new-key',
                CopySource: `${bucketName}/test-key`,
              }),
            ])
          })

          it('should add span pointer for completeMultipartUpload operation', async () => {
            const partSize = 5 * 1024 * 1024
            const part1Data = Buffer.alloc(partSize, 'a')
            const part2Data = Buffer.alloc(partSize, 'b')

            const multipartData = await callViaCallback(s3, 'createMultipartUpload', {
              Bucket: bucketName,
              Key: 'multipart-test',
            })

            const [part1, part2] = await Promise.all([
              callViaCallback(s3, 'uploadPart', {
                Bucket: bucketName,
                Key: 'multipart-test',
                PartNumber: 1,
                UploadId: multipartData.UploadId,
                Body: part1Data,
              }),
              callViaCallback(s3, 'uploadPart', {
                Bucket: bucketName,
                Key: 'multipart-test',
                PartNumber: 2,
                UploadId: multipartData.UploadId,
                Body: part2Data,
              }),
            ])
            const completeParams = {
              Bucket: bucketName,
              Key: 'multipart-test',
              UploadId: multipartData.UploadId,
              MultipartUpload: {
                Parts: [
                  { PartNumber: 1, ETag: part1.ETag },
                  { PartNumber: 2, ETag: part2.ETag },
                ],
              },
            }
            const tracePromise = agent.assertFirstTraceSpan(span => {
              const links = JSON.parse(span.meta?.['_dd.span_links'] || '[]')

              assert.strictEqual(links.length, 1)
              assert.deepStrictEqual(links[0].attributes, {
                'ptr.kind': S3_PTR_KIND,
                'ptr.dir': SPAN_POINTER_DIRECTION.DOWNSTREAM,
                'ptr.hash': '422412aa6b472a7194f3e24f4b12b4a6',
                'link.kind': 'span-pointer',
              })
            }, { spanResourceMatch: /^completeMultipartUpload / })

            await Promise.all([
              tracePromise,
              callViaCallback(s3, 'completeMultipartUpload', completeParams),
            ])
          })
        })

        it('should allow disabling a specific span kind of a service', (done) => {
          let total = 0

          agent.assertSomeTraces(traces => {
            const span = traces[0][0]
            assertObjectContains(span, {
              name: 'aws.request',
              resource: `putObject ${bucketName}`,
            })

            assertObjectContains(span.meta, {
              bucketname: bucketName,
              aws_service: 'S3',
              region: 'us-east-1',
            })

            total++
          }, { timeoutMs: 100 }).catch(() => {})

          s3.putObject({
            Bucket: bucketName,
            Key: 'test-key',
            Body: 'test body',
          }, (err) => {
            if (err) return done(err)

            setTimeout(() => {
              try {
                assert.strictEqual(total, 1)
                done()
              } catch (e) {
                done(e)
              }
            }, 250)
          })
        })
      })
    })
  })
})
