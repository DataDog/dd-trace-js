'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { once } = require('node:events')
const http = require('node:http')
const { promisify } = require('node:util')

const { after, before, describe, it } = require('mocha')
const semver = require('semver')

const { ERROR_MESSAGE, ERROR_STACK, ERROR_TYPE } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const { assertObjectContains } = require('../../../integration-tests/helpers')
const { setup, sort, withAwsSdkV2Versions, withAwsSdkV3Versions, withAwsSdkVersions } = require('./spec_helpers')

const execFileAsync = promisify(execFile)

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

  describe('default service', () => {
    setup()

    withAwsSdkV2Versions('>=2.3.0', version => {
      let server
      let sts

      before(async () => {
        await agent.load('aws-sdk', { aws: { service: 'test-aws-fallback' } })

        const responseBody = [
          '<GetSessionTokenResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">',
          '<GetSessionTokenResult><Credentials><AccessKeyId>new-key</AccessKeyId>',
          '<SecretAccessKey>new-secret</SecretAccessKey><SessionToken>new-token</SessionToken>',
          '<Expiration>2030-01-01T00:00:00Z</Expiration></Credentials></GetSessionTokenResult>',
          '<ResponseMetadata><RequestId>abc</RequestId></ResponseMetadata></GetSessionTokenResponse>',
        ].join('')
        server = http.createServer((request, response) => {
          response.writeHead(200, { 'content-type': 'text/xml' })
          response.end(responseBody)
        })
        server.listen(0, '127.0.0.1')
        await once(server, 'listening')

        const AWS = require(`../../../versions/aws-sdk@${version}`).get()
        sts = new AWS.STS({
          region: 'us-east-1',
          endpoint: `http://127.0.0.1:${server.address().port}`,
          credentials: { accessKeyId: 'x', secretAccessKey: 'y' },
          maxRetries: 0,
        })
      })

      after(() => Promise.all([agent.close(), new Promise(resolve => server.close(resolve))]))

      it('traces promise requests with the aws service configuration', async () => {
        const tracePromise = agent.assertSomeTraces(traces => {
          const span = traces.flat().find(span => span.name === 'aws.request')
          assert.ok(span)
          assert.strictEqual(span.service, 'test-aws-fallback')
          assert.strictEqual(span.meta['aws.service'], 'STS')
        })
        const [response] = await Promise.all([sts.getSessionToken({}).promise(), tracePromise])

        assert.strictEqual(response.Credentials.AccessKeyId, 'new-key')
      })

      it('traces callback requests with the aws service configuration', async () => {
        const tracePromise = agent.assertSomeTraces(traces => {
          const span = traces.flat().find(span => span.name === 'aws.request')
          assert.ok(span)
          assert.strictEqual(span.service, 'test-aws-fallback')
          assert.strictEqual(span.meta['aws.service'], 'STS')
        })
        const responsePromise = new Promise((resolve, reject) => {
          sts.getSessionToken({}).send((error, response) => error ? reject(error) : resolve(response))
        })
        const [response] = await Promise.all([responsePromise, tracePromise])

        assert.strictEqual(response.Credentials.AccessKeyId, 'new-key')
      })
    })

    class GetCallerIdentityCommand {
      constructor () {
        this.input = {}
      }

      resolveMiddleware () {
        return () => Promise.resolve({ output: { Account: '123456789012' } })
      }
    }

    const testDefaultService = (version, moduleName) => {
      let client

      before(async () => {
        await agent.load('aws-sdk', { aws: { service: 'test-aws-fallback' } })

        const Client = require(`../../../versions/${moduleName}@${version}`).get().Client
        class STSClient extends Client {}

        client = new STSClient({
          region: () => Promise.resolve('us-east-1'),
          requestHandler: {},
          serviceId: 'STS',
        })
      })

      after(() => agent.close())

      it('traces services without a dedicated plugin', async () => {
        const tracePromise = agent.assertSomeTraces(traces => {
          const span = traces[0][0]

          assert.strictEqual(span.name, 'aws.request')
          assert.strictEqual(span.resource, 'getCallerIdentity')
          assert.strictEqual(span.service, 'test-aws-fallback')
          assert.strictEqual(span.meta['aws.service'], 'STS')
        })

        const response = await client.send(new GetCallerIdentityCommand())

        assert.deepStrictEqual(response, { Account: '123456789012' })
        await tracePromise
      })

      it('traces callback requests without a dedicated plugin', async () => {
        const tracePromise = agent.assertSomeTraces(traces => {
          const span = traces[0][0]

          assert.strictEqual(span.name, 'aws.request')
          assert.strictEqual(span.service, 'test-aws-fallback')
          assert.strictEqual(span.meta['aws.service'], 'STS')
        })
        const responsePromise = new Promise((resolve, reject) => {
          client.send(new GetCallerIdentityCommand(), (error, response) => error ? reject(error) : resolve(response))
        })
        const [response] = await Promise.all([responsePromise, tracePromise])

        assert.deepStrictEqual(response, { Account: '123456789012' })
      })

      it('honors the aws service configuration when disabled', async () => {
        const tracer = require('../../dd-trace')
        tracer.use('aws-sdk', { aws: false })

        const noTraces = agent.assertNoTraces(traces => {
          assert.strictEqual(traces.flat().some(span => span.name === 'aws.request'), false)
        })
        const [response] = await Promise.all([client.send(new GetCallerIdentityCommand()), noTraces])

        assert.deepStrictEqual(response, { Account: '123456789012' })
      })
    }

    withAwsSdkV3Versions(testDefaultService)
    withVersions('aws-sdk', ['@smithy/smithy-client'], '>=1.0.3', testDefaultService)

    withAwsSdkV3Versions((version, moduleName) => {
      describe('disabled fallback service', () => {
        let client
        let tracer
        let originalEnabled

        before(async () => {
          originalEnabled = process.env.DD_TRACE_AWS_SDK_AWS_ENABLED
          process.env.DD_TRACE_AWS_SDK_AWS_ENABLED = 'false'
          tracer = await agent.load('aws-sdk')

          const Client = require(`../../../versions/${moduleName}@${version}`).get().Client
          class STSClient extends Client {}
          client = new STSClient({
            region: () => Promise.resolve('us-east-1'),
            requestHandler: {},
            serviceId: 'STS',
          })
        })

        after(async () => {
          if (originalEnabled === undefined) delete process.env.DD_TRACE_AWS_SDK_AWS_ENABLED
          else process.env.DD_TRACE_AWS_SDK_AWS_ENABLED = originalEnabled
          await agent.close()
        })

        it('does not tag an active parent span', async () => {
          const tracePromise = agent.assertSomeTraces(traces => {
            const spans = traces.flat()
            assert.strictEqual(spans.some(span => span.name === 'aws.request'), false)

            const parent = spans.find(span => span.name === 'parent')
            assert.ok(parent)
            assert.strictEqual(parent.meta['aws.region'], undefined)
            assert.strictEqual(parent.meta.region, undefined)
            assert.strictEqual(parent.meta['aws.partition'], undefined)
          })
          const [response] = await Promise.all([
            tracer.trace('parent', () => client.send(new GetCallerIdentityCommand())),
            tracePromise,
          ])

          assert.deepStrictEqual(response, { Account: '123456789012' })
        })
      })
    })

    it('does not raise a plugin error when disabled in a serverless process', async function () {
      this.timeout(15000)
      await execFileAsync(process.execPath, [require.resolve('./fixtures/disabled-default-serverless')], {
        env: {
          ...process.env,
          AWS_LAMBDA_FUNCTION_NAME: 'test',
          DD_TRACE_AWS_SDK_AWS_ENABLED: 'false',
          DD_TRACE_EXPERIMENTAL_EXPORTER: 'agent',
        },
        timeout: 10000,
      })
    })
  })
})
