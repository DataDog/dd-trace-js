'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const { setup, sort } = require('./spec_helpers')
const semver = require('semver')

describe('Plugin', () => {
  // TODO: use the Request class directly for generic tests
  // TODO: add test files for every service
  describe('aws-sdk', function () {
    setup()

    withVersions('aws-sdk', 'aws-sdk', version => {
      let AWS
      let s3
      let sqs
      let tracer

      describe('without configuration', () => {
        before(() => {
          return agent.load(['aws-sdk', 'http'], [{}, { server: false }])
        })

        before(() => {
          AWS = require(`../../../versions/aws-sdk@${version}`).get()

          const endpoint = new AWS.Endpoint('http://127.0.0.1:4572')

          s3 = new AWS.S3({ endpoint, s3ForcePathStyle: true })
          tracer = require('../../dd-trace')
        })

        after(() => {
          return agent.close({ ritmReset: false, wipe: true })
        })

        it('should instrument service methods with a callback', (done) => {
          agent.use(traces => {
            const span = sort(traces[0])[0]

            expect(span).to.include({
              name: 'aws.request',
              resource: 'listBuckets',
              service: 'test-aws-s3'
            })

            expect(span.meta).to.include({
              'component': 'aws-sdk',
              'aws.region': 'us-east-1',
              'aws.service': 'S3',
              'aws.operation': 'listBuckets'
            })
          }).then(done, done)

          s3.listBuckets(e => e && done(e))
        })

        it('should mark error responses', (done) => {
          let error

          agent.use(traces => {
            const span = sort(traces[0])[0]

            expect(span).to.include({
              name: 'aws.request',
              resource: 'listBuckets',
              service: 'test-aws-s3'
            })

            expect(span.meta).to.include({
              'error.type': error.name,
              'error.msg': error.message,
              'error.stack': error.stack
            })
          }).then(done, done)

          s3.listBuckets({ 'BadParam': 'badvalue' }, e => {
            error = e
          })
        })

        if (semver.intersects(version, '>=2.3.0')) {
          it('should instrument service methods using promise()', (done) => {
            agent.use(traces => {
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

            agent.use(traces => {
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
            s3.listBuckets(() => {
              try {
                expect(tracer.scope().active()).to.equal(span)
                done()
              } catch (e) {
                done(e)
              }
            })
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
                  'error': 0
                })
              }
            }
          }, { server: false }])
        })

        before(() => {
          AWS = require(`../../../versions/aws-sdk@${version}`).get()

          const endpoint = new AWS.Endpoint('http://127.0.0.1:5000')

          s3 = new AWS.S3({ endpoint, s3ForcePathStyle: true })
          tracer = require('../../dd-trace')
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        it('should be configured', (done) => {
          agent.use(traces => {
            const span = sort(traces[0])[0]
            expect(span).to.include({
              name: 'aws.request',
              resource: 'listBuckets',
              service: 'test'
            })
            expect(span).to.have.property('error', 0)
            expect(span.meta).to.include({
              'hook.operation': 'listBuckets'
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
          AWS = require(`../../../versions/aws-sdk@${version}`).get()

          s3 = new AWS.S3({ endpoint: new AWS.Endpoint('http://127.0.0.1:4572'), s3ForcePathStyle: true })
          sqs = new AWS.SQS({ endpoint: new AWS.Endpoint('http://127.0.0.1:4576') })
          tracer = require('../../dd-trace')
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        it('should allow disabling a specific service', (done) => {
          let total = 0

          agent.use(traces => {
            const span = sort(traces[0])[0]

            expect(span).to.include({
              name: 'aws.request',
              resource: 'listBuckets',
              service: 'test'
            })

            total++
          }).catch(() => {}, { timeoutMs: 100 })

          agent.use(traces => {
            const span = sort(traces[0])[0]

            expect(span).to.include({
              name: 'aws.request',
              resource: 'listQueues',
              service: 'test'
            })

            total++
          }).catch((e) => {}, { timeoutMs: 100 })

          s3.listBuckets(() => {})
          sqs.listQueues(() => {})

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
