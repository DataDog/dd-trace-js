'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const { setup } = require('./spec_helpers')
const axios = require('axios')
const { rawExpectedSchema } = require('./s3-naming')

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

    withVersions('aws-sdk', ['aws-sdk', '@aws-sdk/smithy-client'], (version, moduleName) => {
      let AWS
      let s3
      let tracer

      const s3ClientName = moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-s3' : 'aws-sdk'
      describe('with configuration', () => {
        before(() => {
          tracer = require('../../dd-trace')
          tracer.init()
          return agent.load('aws-sdk')
        })

        before(done => {
          AWS = require(`../../../versions/${s3ClientName}@${version}`).get()

          s3 = new AWS.S3({ endpoint: 'http://127.0.0.1:4566', s3ForcePathStyle: true, region: 'us-east-1' })
          s3.createBucket({ Bucket: bucketName }, (err) => {
            if (err) return done(err)
            done()
          })
        })

        after(done => {
          s3.deleteBucket({ Bucket: bucketName }, () => {
            done()
          })
        })

        after(async () => {
          await resetLocalStackS3()
          return agent.close({ ritmReset: false })
        })

        withPeerService(
          () => tracer,
          'aws-sdk',
          (done) => s3.putObject({
            Bucket: bucketName,
            Key: 'test-key',
            Body: 'test body'
          }, (err) => err && done(err)),
          bucketName, 'bucketname')

        withNamingSchema(
          (done) => s3.putObject({
            Bucket: bucketName,
            Key: 'test-key',
            Body: 'test body'
          }, (err) => err && done(err)),
          rawExpectedSchema.outbound
        )

        it('should allow disabling a specific span kind of a service', (done) => {
          let total = 0

          agent.use(traces => {
            const span = traces[0][0]
            expect(span).to.include({
              name: 'aws.request',
              resource: `putObject ${bucketName}`
            })

            expect(span.meta).to.include({
              'bucketname': bucketName,
              'aws_service': 'S3',
              'region': 'us-east-1'
            })

            total++
          }).catch(() => {}, { timeoutMs: 100 })

          s3.putObject({
            Bucket: bucketName,
            Key: 'test-key',
            Body: 'test body'
          }, (err) => {
            if (err) return done(err)

            setTimeout(() => {
              try {
                expect(total).to.equal(1)
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
