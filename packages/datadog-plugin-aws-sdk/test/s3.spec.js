/* eslint-disable max-len */
'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const { setup } = require('./spec_helpers')

class TestSpanProcessor {
  constructor () {
    this.unprocessedSpans = []
  }

  process (span) {
    // Store the unprocessed span
    this.unprocessedSpans.push(span)
  }
}

const s3Params = {
  Bucket: 'examplebucket',
  CreateBucketConfiguration: {
    LocationConstraint: 'sa-east-1'
  }
}
let tracer

describe('S3', function () {
  this.timeout(100000)
  describe('aws-sdk (s3)', function () {
    setup()

    withVersions('aws-sdk', ['aws-sdk', '@aws-sdk/smithy-client'], (version, moduleName) => {
      let AWS
      let s3

      const s3ClientName = moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-s3' : 'aws-sdk'
      describe('without configuration', () => {
        before(() => {
          tracer = require('../../dd-trace')

          return agent.load('aws-sdk')
        })

        before(done => {
          AWS = require(`../../../versions/${s3ClientName}@${version}`).get()

          s3 = new AWS.S3({
            endpoint: 'http://127.0.0.1:4566',
            region: 'sa-east-1',
            s3ForcePathStyle: true
          })
          // This is simply to intercept the finished spans by creating our own barebones Span Processor and replacing the default span Processor.
          const testSpanProcessor = new TestSpanProcessor()
          tracer._tracer._processor = testSpanProcessor
          done()
        })

        after(done => {
          tracer._tracer._processor.unprocessedSpans = []
          s3.deleteBucket({ Bucket: 'examplebucket' }, done)
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })
        it('should run the getObject in the context of its span', async () => {
          // Convert the createBucket function to a Promise-based function
          const createBucketPromise = (params) => {
            return new Promise((resolve, reject) => {
              s3.createBucket(params, (err, data) => {
                if (err) reject(err)
                else resolve(data)
              })
            })
          }

          // Await the createBucket function so test doesn't speed past before we have the chance to assert on the finished spans
          await createBucketPromise(s3Params)
          const span = tracer._tracer._processor.unprocessedSpans[0]
          expect(span.context()._tags['aws.operation']).to.equal('createBucket')
          expect(span.context()._tags['bucketname']).to.equal('examplebucket')
          expect(span.context()._tags['aws_service']).to.equal('S3')
          expect(span.context()._tags['region']).to.equal('sa-east-1')
        })
      })
    })
  })
})
