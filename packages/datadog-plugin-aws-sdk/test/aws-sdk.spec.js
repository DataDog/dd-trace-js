'use strict'

const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { setImmediate } = require('node:timers/promises')
const { promisify } = require('node:util')

const { after, before, describe, it } = require('mocha')
const semver = require('semver')
const sinon = require('sinon')

const { ERROR_MESSAGE, ERROR_STACK, ERROR_TYPE } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const { assertObjectContains } = require('../../../integration-tests/helpers')
const { setup, sort, withAwsSdkV2Versions, withAwsSdkVersions } = require('./spec_helpers')

describe('Plugin', () => {
  // The config singleton is built lazily on the first `agent.load(...)` and is
  // not rebuilt across describes, so any env var the singleton needs to see
  // must be set before then. The 'with env variable _BATCH_PROPAGATION_ENABLED'
  // describe asserts on these specific values; they're harmless to the other
  // describes (which assert on programmatic config that wins in the `??` chain).
  const ORIGINAL_BATCH_PROPAGATION_ENV = {
    GLOBAL: process.env.DD_TRACE_AWS_SDK_BATCH_PROPAGATION_ENABLED,
    KINESIS: process.env.DD_TRACE_AWS_SDK_KINESIS_BATCH_PROPAGATION_ENABLED,
    SQS: process.env.DD_TRACE_AWS_SDK_SQS_BATCH_PROPAGATION_ENABLED,
  }
  before(() => {
    process.env.DD_TRACE_AWS_SDK_BATCH_PROPAGATION_ENABLED = 'true'
    process.env.DD_TRACE_AWS_SDK_KINESIS_BATCH_PROPAGATION_ENABLED = 'false'
    process.env.DD_TRACE_AWS_SDK_SQS_BATCH_PROPAGATION_ENABLED = 'true'
  })
  after(() => {
    function restore (name, original) {
      if (original === undefined) delete process.env[name]
      else process.env[name] = original
    }
    restore('DD_TRACE_AWS_SDK_BATCH_PROPAGATION_ENABLED', ORIGINAL_BATCH_PROPAGATION_ENV.GLOBAL)
    restore('DD_TRACE_AWS_SDK_KINESIS_BATCH_PROPAGATION_ENABLED', ORIGINAL_BATCH_PROPAGATION_ENV.KINESIS)
    restore('DD_TRACE_AWS_SDK_SQS_BATCH_PROPAGATION_ENABLED', ORIGINAL_BATCH_PROPAGATION_ENV.SQS)
  })

  describe('aws-sdk region resolution', () => {
    withVersions('aws-sdk', '@aws-sdk/client-s3', '*', version => {
      let AWS
      let directory
      let envStub

      before(async () => {
        directory = mkdtempSync(join(tmpdir(), 'dd-trace-aws-region-'))
        const env = {
          ...process.env,
          AWS_CONFIG_FILE: join(directory, 'config'),
          AWS_EC2_METADATA_DISABLED: 'true',
          AWS_SHARED_CREDENTIALS_FILE: join(directory, 'credentials'),
        }
        delete env.AWS_REGION
        delete env.AWS_DEFAULT_REGION
        envStub = sinon.stub(process, 'env').value(env)
        await agent.load('aws-sdk')
        AWS = require(`../../../versions/@aws-sdk/client-s3@${version}`).get()
      })

      after(async () => {
        envStub.restore()
        rmSync(directory, { recursive: true, force: true })
        await agent.close()
      })

      for (const api of ['promise', 'callback']) {
        for (const scenario of ['missing region', 'rejected provider', 'resolved region']) {
          it(`handles ${scenario} with the ${api} API`, async () => {
            const providerError = new Error('Region provider failed')
            const region = scenario === 'resolved region'
              ? 'us-east-1'
              : scenario === 'rejected provider' ? () => Promise.reject(providerError) : undefined
            const handle = sinon.stub().resolves({
              response: {
                statusCode: 200,
                headers: {},
                body: Buffer.from('<ListAllMyBucketsResult><Buckets/></ListAllMyBucketsResult>'),
              },
            })
            const client = new AWS.S3Client({
              ...(region === undefined ? {} : { region }),
              credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
              requestHandler: { handle },
            })
            const succeeds = scenario === 'resolved region'
            const message = scenario === 'missing region' ? 'Region is missing' : providerError.message
            const unhandledRejection = sinon.spy()
            process.once('unhandledRejection', unhandledRejection)

            const traces = agent.assertSomeTraces(traces => {
              const span = traces[0][0]
              assert.equal(span.name, 'aws.request')
              assert.equal(span.resource, 'listBuckets')
              assert.equal(span.error, succeeds ? 0 : 1)
              assert.equal(span.meta['aws.region'], succeeds ? region : undefined)
              assert.equal(span.meta.region, succeeds ? region : undefined)
              assert.equal(span.meta['aws.partition'], succeeds ? 'aws' : undefined)
              if (!succeeds) {
                assert.equal(span.meta['error.message'], message)
                assert.equal(span.meta['error.type'], 'Error')
              }
            })

            try {
              const command = new AWS.ListBucketsCommand({})
              const send = promisify(client.send)
              const result = api === 'promise'
                ? client.send(command)
                : send.call(client, command)
              const assertion = succeeds
                ? result.then(output => assert.deepEqual(output.Buckets, []))
                : assert.rejects(result, scenario === 'rejected provider' ? providerError : { message })
              await Promise.all([traces, assertion])
              // Let Node process any unhandled rejection from the tracer's separate region lookup.
              await setImmediate()
              assert.equal(unhandledRejection.callCount, 0)
              assert.equal(handle.callCount, succeeds ? 1 : 0)
            } finally {
              process.removeListener('unhandledRejection', unhandledRejection)
              client.destroy()
            }
          })
        }
      }
    })
  })

  // TODO: use the Request class directly for generic tests
  // TODO: add test files for every service
  describe('aws-sdk direct import', function () {
    setup()

    withAwsSdkV2Versions((version) => {
      if (semver.intersects(version, '>2.3.0')) {
        const S3 = require(`../../../versions/aws-sdk@${version}`).get('aws-sdk/clients/s3')
        const s3 = new S3({ endpoint: 'http://127.0.0.1:4566', region: 'us-east-1', s3ForcePathStyle: true })
        require('../../dd-trace')
        before(() => {
          return agent.load(['aws-sdk', 'http'], [{}, { server: false }])
        })

        after(() => {
          return agent.close()
        })

        it('should instrument service methods with a callback', (done) => {
          agent.assertSomeTraces(traces => {
            const span = sort(traces[0])[0]

            assertObjectContains(span, {
              name: 'aws.request',
              resource: 'listBuckets',
              service: 'test-aws-s3',
            })

            assertObjectContains(span.meta, {
              component: 'aws-sdk',
              'aws.region': 'us-east-1',
              region: 'us-east-1',
              'aws.partition': 'aws',
              'aws.service': 'S3',
              aws_service: 'S3',
              'aws.operation': 'listBuckets',
            })
          // first S3 call against localstack on the oldest SDK is slow to connect
          }, { timeoutMs: 5000 }).then(done, done)

          s3.listBuckets({}, e => e && done(e))
        })

        it('should instrument service methods using promise()', (done) => {
          agent.assertSomeTraces(traces => {
            const span = sort(traces[0])[0]

            assertObjectContains(span, {
              name: 'aws.request',
              resource: 'listBuckets',
              service: 'test-aws-s3',
            })
          }).then(done, done)

          s3.listBuckets().promise().catch(done)
        })
      }
    })
  })

  describe('aws-sdk', function () {
    setup()

    withAwsSdkVersions((version, moduleName) => {
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
          return agent.close()
        })

        it('should instrument service methods with a callback', (done) => {
          agent.assertSomeTraces(traces => {
            const span = sort(traces[0])[0]

            assertObjectContains(span, {
              name: 'aws.request',
              resource: 'listBuckets',
              service: 'test-aws-s3',
            })

            assertObjectContains(span.meta, {
              component: 'aws-sdk',
              'aws.region': 'us-east-1',
              region: 'us-east-1',
              'aws.partition': 'aws',
              'aws.service': 'S3',
              aws_service: 'S3',
              'aws.operation': 'listBuckets',
            })
          }).then(done, done)

          s3.listBuckets({}, e => e && done(e))
        })

        it('should mark error responses', (done) => {
          let error

          agent.assertSomeTraces(traces => {
            const span = sort(traces[0])[0]

            assertObjectContains(span, {
              name: 'aws.request',
              resource: 'completeMultipartUpload my-bucket',
              service: 'test-aws-s3',
            })

            assertObjectContains(span.meta, {
              [ERROR_TYPE]: error.name,
              [ERROR_MESSAGE]: error.message,
              [ERROR_STACK]: error.stack,
              component: 'aws-sdk',
            })
            if (semver.intersects(version, '>=2.3.4')) {
              assert.match(span.meta['aws.response.request_id'], /\w{8}(-\w{4}){3}-\w{12}/)
            }
          }).then(done, done)

          s3.completeMultipartUpload({
            Bucket: 'my-bucket',
            Key: 'my-key',
            UploadId: 'my-upload-id',
          }, e => {
            error = e
          })
        })

        if (!semver.intersects(version, '<3')) {
          it('should instrument service methods using promises', (done) => {
            agent.assertSomeTraces(traces => {
              const span = sort(traces[0])[0]

              assertObjectContains(span, {
                name: 'aws.request',
                resource: 'listBuckets',
                service: 'test-aws-s3',
              })
            }).then(done, done)

            s3.listBuckets({}).catch(done)
          })
        } else if (!semver.intersects(version, '<2.3.0')) {
          it('should instrument service methods using promise()', (done) => {
            agent.assertSomeTraces(traces => {
              const span = sort(traces[0])[0]

              assertObjectContains(span, {
                name: 'aws.request',
                resource: 'listBuckets',
                service: 'test-aws-s3',
              })
            }).then(done, done)

            s3.listBuckets().promise().catch(done)
          })

          it('should instrument service methods using promise() with custom promises', (done) => {
            AWS.config.setPromisesDependency(null)

            agent.assertSomeTraces(traces => {
              const span = sort(traces[0])[0]

              assertObjectContains(span, {
                name: 'aws.request',
                resource: 'listBuckets',
                service: 'test-aws-s3',
              })
            }).then(done, done)

            s3.listBuckets().promise().catch(done)
          })
        }

        it('should bind callbacks to the correct active span', (done) => {
          const span = tracer.startSpan('test')

          tracer.scope().activate(span, () => {
            s3.listBuckets({}, () => {
              try {
                assert.strictEqual(tracer.scope().active(), span)
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
            { region: 'us-gov-west-1', partition: 'aws-us-gov' },
          ]

          let completed = 0
          const total = testCases.length

          testCases.forEach(({ region, partition }) => {
            const regionalS3 = new AWS.S3({
              endpoint: 'http://127.0.0.1:4566',
              region,
              s3ForcePathStyle: true,
            })

            agent.assertSomeTraces(traces => {
              const span = sort(traces[0])[0]

              assertObjectContains(span.meta, {
                'aws.region': region,
                region,
                'aws.partition': partition,
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
            hooks: {
              request (span, response) {
                span.setTag('hook.operation', response.request.operation)
                span.addTags({
                  error: 0,
                })
              },
            },
          }, { server: false }])
        })

        before(() => {
          AWS = require(`../../../versions/${s3ClientName}@${version}`).get()
          s3 = new AWS.S3({ endpoint: 'http://127.0.0.1:5000', region: 'us-east-1', s3ForcePathStyle: true })
          tracer = require('../../dd-trace')
        })

        after(() => {
          return agent.close()
        })

        it('should be configured', (done) => {
          agent.assertSomeTraces(traces => {
            const span = sort(traces[0])[0]
            assertObjectContains(span, {
              name: 'aws.request',
              resource: 'listBuckets',
              service: 'test',
            })
            assertObjectContains(span, {
              error: 0,
              meta: {
                'hook.operation': 'listBuckets',
                component: 'aws-sdk',
              },
            })
          }).then(done, done)

          s3.listBuckets({}, () => {})
        })
      })

      describe('with a service function', () => {
        before(() => {
          return agent.load(['aws-sdk', 'http'], [{
            service (params) {
              return params?.Bucket ? `s3-bucket-${params.Bucket}` : undefined
            },
          }, { server: false }])
        })

        before(() => {
          AWS = require(`../../../versions/${s3ClientName}@${version}`).get()
          s3 = new AWS.S3({ endpoint: 'http://127.0.0.1:4566', region: 'us-east-1', s3ForcePathStyle: true })
          tracer = require('../../dd-trace')
        })

        after(() => {
          return agent.close()
        })

        it('derives the service name from the request params', (done) => {
          agent.assertSomeTraces(traces => {
            const span = sort(traces[0])[0]

            assertObjectContains(span, {
              name: 'aws.request',
              resource: 'completeMultipartUpload my-bucket',
              service: 's3-bucket-my-bucket',
            })
          }).then(done, done)

          s3.completeMultipartUpload({
            Bucket: 'my-bucket',
            Key: 'my-key',
            UploadId: 'my-upload-id',
          }, () => {})
        })

        it('falls back to the default service name when the function returns undefined', (done) => {
          agent.assertSomeTraces(traces => {
            const span = sort(traces[0])[0]

            assertObjectContains(span, {
              name: 'aws.request',
              resource: 'listBuckets',
              service: 'test-aws-s3',
            })
          }).then(done, done)

          s3.listBuckets({}, () => {})
        })
      })

      describe('with a service function returning a non-string', () => {
        before(() => {
          return agent.load(['aws-sdk', 'http'], [{
            service (params) {
              return params?.Bucket ? params.Bucket.length : undefined
            },
          }, { server: false }])
        })

        before(() => {
          AWS = require(`../../../versions/${s3ClientName}@${version}`).get()
          s3 = new AWS.S3({ endpoint: 'http://127.0.0.1:4566', region: 'us-east-1', s3ForcePathStyle: true })
          tracer = require('../../dd-trace')
        })

        after(() => {
          return agent.close()
        })

        it('falls back to the default service name', (done) => {
          agent.assertSomeTraces(traces => {
            const span = sort(traces[0])[0]

            assertObjectContains(span, {
              name: 'aws.request',
              resource: 'completeMultipartUpload my-bucket',
              service: 'test-aws-s3',
            })
          }).then(done, done)

          s3.completeMultipartUpload({
            Bucket: 'my-bucket',
            Key: 'my-key',
            UploadId: 'my-upload-id',
          }, () => {})
        })
      })

      describe('with service configuration', () => {
        before(() => {
          return agent.load(['aws-sdk', 'http'], [{
            service: 'test',
            s3: false,
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
          return agent.close()
        })

        it('should allow disabling a specific service', async () => {
          // s3 is disabled, so its request must never be traced within the window.
          const listBucketsNotTraced = agent.assertNoTraces(traces => {
            for (const trace of traces) {
              for (const span of trace) {
                if (span.name === 'aws.request' && span.resource === 'listBuckets') {
                  throw new Error('listBuckets must not be traced when s3 is disabled')
                }
              }
            }
          })

          // sqs stays enabled, so its request must be traced.
          const listQueuesTraced = agent.assertSomeTraces(traces => {
            const span = sort(traces[0])[0]

            assertObjectContains(span, {
              name: 'aws.request',
              resource: 'listQueues',
              service: 'test',
            })
          })

          s3.listBuckets({}, () => {})
          sqs.listQueues({}, () => {})

          await Promise.all([listBucketsNotTraced, listQueuesTraced])
        })
      })

      describe('with programmatic batchPropagationEnabled configuration', () => {
        before(() => {
          return agent.load(['aws-sdk'], [{
            service: 'test',
            batchPropagationEnabled: true,
            kinesis: {
              batchPropagationEnabled: false,
            },
            sns: false,
            sqs: {
              batchPropagationEnabled: false,
            },
          }])
        })

        before(() => {
          tracer = require('../../dd-trace')
        })

        after(() => {
          return agent.close()
        })

        it('should be configurable on a per-service basis', () => {
          const { kinesis, sns, sqs } = tracer._pluginManager._pluginsByName['aws-sdk'].services

          assert.strictEqual(kinesis.config.batchPropagationEnabled, false)
          assert.strictEqual(sns.config.batchPropagationEnabled, true)
          assert.strictEqual(sns.config.enabled, false)
          assert.strictEqual(sqs.config.batchPropagationEnabled, false)
        })
      })

      describe('with env variable _BATCH_PROPAGATION_ENABLED configuration', () => {
        before(() => {
          process.env.DD_TRACE_AWS_SDK_BATCH_PROPAGATION_ENABLED = 'true'
          process.env.DD_TRACE_AWS_SDK_KINESIS_BATCH_PROPAGATION_ENABLED = 'false'
          process.env.DD_TRACE_AWS_SDK_SQS_BATCH_PROPAGATION_ENABLED = 'true'

          return agent.load(['aws-sdk'])
        })

        before(() => {
          tracer = require('../../dd-trace')
        })

        after(() => {
          return agent.close()
        })

        it('should be configurable on a per-service basis', () => {
          const { kinesis, sns, sqs } = tracer._pluginManager._pluginsByName['aws-sdk'].services

          assert.strictEqual(kinesis.config.batchPropagationEnabled, false)
          assert.strictEqual(sns.config.batchPropagationEnabled, true)
          assert.strictEqual(sqs.config.batchPropagationEnabled, true)
        })
      })
    })
  })
})
