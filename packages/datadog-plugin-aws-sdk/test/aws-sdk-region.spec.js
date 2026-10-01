'use strict'

const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { setImmediate } = require('node:timers/promises')
const { promisify } = require('node:util')

const { after, before, describe, it } = require('mocha')
const sinon = require('sinon')

const { withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')

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
