'use strict'

const { expect } = require('chai')
const { describe, it, before, after } = require('mocha')
const semver = require('semver')

const agent = require('../../dd-trace/test/plugins/agent')
const { setup, sort } = require('./spec-helpers')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const { ERROR_MESSAGE, ERROR_STACK, ERROR_TYPE } = require('../../dd-trace/src/constants')

describe('Plugin', () => {
  // TODO: use the Request class directly for generic tests
  // TODO: add test files for every service
  describe('aws-sdk direct import', function () {
    setup()

    withVersions('aws-sdk', ['aws-sdk'], (version) => {
      if (semver.intersects(version, '>2.3.0')) {
        const S3 = require(`../../../versions/aws-sdk@${version}`).get('aws-sdk/clients/s3')
        const s3 = new S3({ endpoint: 'http://127.0.0.1:4566', region: 'us-east-1', s3ForcePathStyle: true })
        require('../../dd-trace')
        before(() => {
          return agent.load(['aws-sdk', 'http'], [{}, { server: false }])
        })

        after(() => {
          return agent.close({ ritmReset: false, wipe: true })
        })

        it('should instrument service methods with a callback', (done) => {
          agent.assertSomeTraces(traces => {
            const span = sort(traces[0])[0]

            expect(span).to.include({
              name: 'aws.request',
              resource: 'listBuckets',
              service: 'test-aws-s3'
            })

            expect(span.meta).to.include({
              component: 'aws-sdk',
              'aws.region': 'us-east-1',
              region: 'us-east-1',
              partition: 'aws',
              'aws.service': 'S3',
              aws_service: 'S3',
              'aws.operation': 'listBuckets'
            })
          }).then(done, done)

          s3.listBuckets({}, e => e && done(e))
        })

        it('should instrument service methods using promise()', (done) => {
          agent.assertSomeTraces(traces => {
            const span = sort(traces[0])[0]

            expect(span).to.include({
              name: 'aws.request',
              resource: 'listBuckets',
              service: 'test-aws-s3'
            })
          }).then(done, done)

          s3.listBuckets().promise().catch(done)
        })
      }
    })
  })

  describe('aws-sdk', function () {
    setup()

    withVersions('aws-sdk', ['aws-sdk', '@aws-sdk/smithy-client'], (version, moduleName) => {
      let AWS
      let s3
      let sqs
      let tracer

      const s3ClientName = moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-s3' : 'aws-sdk'
      const sqsClientName = moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-sqs' : 'aws-sdk'

      describe('without configuration', () => {
        before(() => {
          return agent.load(['aws-sdk', 'http'], [{}, { server: false }])
        })

        before(() => {
          AWS = require(`../../../versions/${s3ClientName}@${version}`).get()
          s3 = new AWS.S3({ endpoint: 'http://127.0.0.1:4566', region: 'us-east-1', s3ForcePathStyle: true })
          tracer = require('../../dd-trace')
        })

        after(() => {
          return agent.close({ ritmReset: false, wipe: true })
        })

        it('should instrument service methods with a callback', (done) => {
          agent.assertSomeTraces(traces => {
            const span = sort(traces[0])[0]

            expect(span).to.include({
              name: 'aws.request',
              resource: 'listBuckets',
              service: 'test-aws-s3'
            })

            expect(span.meta).to.include({
              component: 'aws-sdk',
              'aws.region': 'us-east-1',
              region: 'us-east-1',
              partition: 'aws',
              'aws.service': 'S3',
              aws_service: 'S3',
              'aws.operation': 'listBuckets'
            })
          }).then(done, done)

          s3.listBuckets({}, e => e && done(e))
        })

        it('should mark error responses', (done) => {
          let error

          agent.assertSomeTraces(traces => {
            const span = sort(traces[0])[0]

            expect(span).to.include({
              name: 'aws.request',
              resource: 'completeMultipartUpload my-bucket',
              service: 'test-aws-s3'
            })

            expect(span.meta).to.include({
              [ERROR_TYPE]: error.name,
              [ERROR_MESSAGE]: error.message,
              [ERROR_STACK]: error.stack,
              component: 'aws-sdk'
            })
            if (semver.intersects(version, '>=2.3.4')) {
              expect(span.meta['aws.response.request_id']).to.match(/[\w]{8}(-[\w]{4}){3}-[\w]{12}/)
            }
          }).then(done, done)

          s3.completeMultipartUpload({
            Bucket: 'my-bucket',
            Key: 'my-key',
            UploadId: 'my-upload-id'
          }, e => {
            error = e
          })
        })

        if (!semver.intersects(version, '<3')) {
          it('should instrument service methods using promises', (done) => {
            agent.assertSomeTraces(traces => {
              const span = sort(traces[0])[0]

              expect(span).to.include({
                name: 'aws.request',
                resource: 'listBuckets',
                service: 'test-aws-s3'
              })
            }).then(done, done)

            s3.listBuckets({}).catch(done)
          })
        } else if (!semver.intersects(version, '<2.3.0')) {
          it('should instrument service methods using promise()', (done) => {
            agent.assertSomeTraces(traces => {
              const span = sort(traces[0])[0]

              expect(span).to.include({
                name: 'aws.request',
                resource: 'listBuckets',
                service: 'test-aws-s3'
              })
            }).then(done, done)

            s3.listBuckets().promise().catch(done)
          })

          it('should instrument service methods using promise() with custom promises', (done) => {
            AWS.config.setPromisesDependency(null)

            agent.assertSomeTraces(traces => {
              const span = sort(traces[0])[0]

              expect(span).to.include({
                name: 'aws.request',
                resource: 'listBuckets',
                service: 'test-aws-s3'
              })
            }).then(done, done)

            s3.listBuckets().promise().catch(done)
          })
        }

        it('should bind callbacks to the correct active span', (done) => {
          const span = {}

          tracer.scope().activate(span, () => {
            s3.listBuckets({}, () => {
              try {
                expect(tracer.scope().active()).to.equal(span)
                done()
              } catch (e) {
                done(e)
              }
            })
          })
        })

        it('should set the correct partition tag for various regions', (done) => {
          const testCases = [
            { region: 'us-east-1', partition: 'aws' },
            { region: 'eu-west-1', partition: 'aws' },
            { region: 'cn-north-1', partition: 'aws-cn' },
            { region: 'us-gov-west-1', partition: 'aws-us-gov' }
          ]

          let completed = 0
          const total = testCases.length

          testCases.forEach(({ region, partition }) => {
            const regionalS3 = new AWS.S3({
              endpoint: 'http://127.0.0.1:4566',
              region,
              s3ForcePathStyle: true
            })

            agent.assertSomeTraces(traces => {
              const span = sort(traces[0])[0]

              expect(span.meta).to.include({
                'aws.region': region,
                region,
                partition
              })

              if (++completed === total) {
                done()
              }
            }).then(null, done)

            regionalS3.listBuckets({}, () => {})
          })
        })
      })

      describe('with configuration', () => {
        before(() => {
          return agent.load(['aws-sdk', 'http'], [{
            service: 'test',
            splitByAwsService: false,
            hooks: {
              request (span, response) {
                span.setTag('hook.operation', response.request.operation)
                span.addTags({
                  error: 0
                })
              }
            }
          }, { server: false }])
        })

        before(() => {
          AWS = require(`../../../versions/${s3ClientName}@${version}`).get()
          s3 = new AWS.S3({ endpoint: 'http://127.0.0.1:5000', region: 'us-east-1', s3ForcePathStyle: true })
          tracer = require('../../dd-trace')
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        it('should be configured', (done) => {
          agent.assertSomeTraces(traces => {
            const span = sort(traces[0])[0]
            expect(span).to.include({
              name: 'aws.request',
              resource: 'listBuckets',
              service: 'test'
            })
            expect(span).to.have.property('error', 0)
            expect(span.meta).to.include({
              'hook.operation': 'listBuckets',
              component: 'aws-sdk'
            })
          }).then(done, done)

          s3.listBuckets({}, () => {})
        })
      })

      describe('with service configuration', () => {
        before(() => {
          return agent.load(['aws-sdk', 'http'], [{
            service: 'test',
            s3: false
          }, { server: false }])
        })

        before(() => {
          const { S3 } = require(`../../../versions/${s3ClientName}@${version}`).get()
          const { SQS } = require(`../../../versions/${sqsClientName}@${version}`).get()

          s3 = new S3({ endpoint: 'http://127.0.0.1:4566', region: 'us-east-1', s3ForcePathStyle: true })
          sqs = new SQS({ endpoint: 'http://127.0.0.1:4566', region: 'us-east-1' })
          tracer = require('../../dd-trace')
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        it('should allow disabling a specific service', (done) => {
          let total = 0

          agent.assertSomeTraces(traces => {
            const span = sort(traces[0])[0]

            expect(span).to.include({
              name: 'aws.request',
              resource: 'listBuckets',
              service: 'test'
            })

            total++
          }).catch(() => {}, { timeoutMs: 100 })

          agent.assertSomeTraces(traces => {
            const span = sort(traces[0])[0]

            expect(span).to.include({
              name: 'aws.request',
              resource: 'listQueues',
              service: 'test'
            })

            total++
          }).catch((e) => {}, { timeoutMs: 100 })

          s3.listBuckets({}, () => {})
          sqs.listQueues({}, () => {})

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

      describe('with programmatic batchPropagationEnabled configuration', () => {
        before(() => {
          return agent.load(['aws-sdk'], [{
            service: 'test',
            batchPropagationEnabled: true,
            kinesis: {
              batchPropagationEnabled: false
            },
            sns: false,
            sqs: {
              batchPropagationEnabled: false
            }
          }])
        })

        before(() => {
          tracer = require('../../dd-trace')
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        it('should be configurable on a per-service basis', () => {
          const { kinesis, sns, sqs } = tracer._pluginManager._pluginsByName['aws-sdk'].services

          expect(kinesis.config.batchPropagationEnabled).to.equal(false)
          expect(sns.config.batchPropagationEnabled).to.equal(true)
          expect(sns.config.enabled).to.equal(false)
          expect(sqs.config.batchPropagationEnabled).to.equal(false)
        })
      })

      describe('with env variable _BATCH_PROPAGATION_ENABLED configuration', () => {
        before(() => {
          process.env.DD_TRACE_AWS_SDK_BATCH_PROPAGATION_ENABLED = true
          process.env.DD_TRACE_AWS_SDK_KINESIS_BATCH_PROPAGATION_ENABLED = false
          process.env.DD_TRACE_AWS_SDK_SQS_BATCH_PROPAGATION_ENABLED = true

          return agent.load(['aws-sdk'])
        })

        before(() => {
          tracer = require('../../dd-trace')
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        it('should be configurable on a per-service basis', () => {
          const { kinesis, sns, sqs } = tracer._pluginManager._pluginsByName['aws-sdk'].services

          expect(kinesis.config.batchPropagationEnabled).to.equal(false)
          expect(sns.config.batchPropagationEnabled).to.equal(true)
          expect(sqs.config.batchPropagationEnabled).to.equal(true)
        })
      })
    })
  })
})
