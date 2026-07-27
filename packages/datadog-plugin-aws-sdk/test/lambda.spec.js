'use strict'

const assert = require('node:assert/strict')

const JSZip = require('jszip')
const { after, before, describe, it } = require('mocha')
const semifies = require('semifies')

const agent = require('../../dd-trace/test/plugins/agent')
const { withNamingSchema } = require('../../dd-trace/test/setup/mocha')
const { assertObjectContains } = require('../../../integration-tests/helpers')
const { rawExpectedSchema } = require('./lambda-naming')
const { setup, withAwsSdkVersions } = require('./spec_helpers')

const zip = new JSZip()

const createClientContext = data => Buffer.from(JSON.stringify(data)).toString('base64')

/**
 * `@aws-sdk/core` 3.977.0 rewrote the clock-skew helper and dropped the guard that ignored an
 * unparsable server `Date`. Resolution reaches that copy through the hoisted tree even from clients
 * that predate `@aws-sdk/core`, so only the declared dependency separates the two.
 *
 * @param {string} version Suffix of the `versions/@aws-sdk/client-lambda@<version>` entry.
 */
function hasUnguardedClockSkewCorrection (version) {
  const versionEntry = require(`../../../versions/@aws-sdk/client-lambda@${version}`)
  const { dependencies } = require(versionEntry.pkgJsonPath())

  return dependencies?.['@aws-sdk/core'] !== undefined &&
    semifies(require(versionEntry.pkgJsonPath('@aws-sdk/core')).version, '>=3.977.0')
}

describe('Plugin', () => {
  describe('aws-sdk (lambda)', function () {
    this.timeout(10000)
    setup()

    withAwsSdkVersions((version, moduleName) => {
      let AWS
      let lambda
      let tracer

      const lambdaClientName = moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-lambda' : 'aws-sdk'

      const parsePayload = payload => {
        if (typeof payload !== 'string') {
          payload = Buffer.from(payload).toString()
        }
        return JSON.parse(payload)
      }

      if (lambdaClientName === '@aws-sdk/client-lambda' && hasUnguardedClockSkewCorrection(version)) {
        describe('clock skew correction against the legacy LocalStack', () => {
          // A failure here means `@aws-sdk/core` guards the unparsable `Date` again, which is the
          // signal to drop this block together with the `disableClockSkewCorrection` option below.
          it('poisons the signature of every request after the first', async () => {
            const { Lambda } = require(`../../../versions/${lambdaClientName}@${version}`).get()
            const skewCorrected = new Lambda({ endpoint: 'http://127.0.0.1:4567', region: 'us-east-1' })

            await skewCorrected.listFunctions({})

            await assert.rejects(
              () => skewCorrected.listFunctions({}),
              { name: 'RangeError', message: 'Invalid time value' }
            )
          })
        })
      }

      describe('with the new trace context propagation', () => {
        let ZipFile

        before(async () => {
          const lambdaFunctionCode = 'exports.handle = async function (event, context) {\n  return context \n}'

          zip.file('handler.js', lambdaFunctionCode.toString())
          ZipFile = await zip.generateAsync({ type: 'nodebuffer' })
        })

        before(done => {
          AWS = require(`../../../versions/${lambdaClientName}@${version}`).get()

          // The pinned legacy LocalStack answers with two `Date` headers, which `@aws-sdk/core`
          // >= 3.977.0 parses to `NaN` and keeps as the skew offset, breaking every later signature.
          lambda = new AWS.Lambda({
            endpoint: 'http://127.0.0.1:4567',
            region: 'us-east-1',
            disableClockSkewCorrection: true,
          })
          lambda.createFunction({
            FunctionName: 'ironmaiden',
            Code: { ZipFile },
            Handler: 'handler.handle',
            Role: 'arn:aws:iam::123456:role/test',
            Runtime: 'nodejs18.x',
          }, (err, res) => {
            if (err) return done(err)

            agent.load('aws-sdk').then(loaded => {
              tracer = loaded
              done()
            }, done)
          })
        })

        after(done => {
          lambda.deleteFunction({ FunctionName: 'ironmaiden' }, err => {
            agent.close().then(() => done(err), done)
          })
        })

        withNamingSchema(
          (done) => lambda.invoke({
            FunctionName: 'ironmaiden',
            Payload: '{}',
            ClientContext: createClientContext({ custom: { megadeth: 'tornado of souls' } }),
          }, (err) => err && done(err)),
          rawExpectedSchema.invoke,
          {
            desc: 'invoke',
          }
        )

        withNamingSchema(
          (done) => lambda.listFunctions({}, (err) => err && done(err)),
          rawExpectedSchema.client,
          {
            desc: 'client',
          }
        )

        it('should propagate the tracing context with existing ClientContext and `custom` key', (done) => {
          let receivedContext

          agent.assertSomeTraces(traces => {
            const span = traces[0][0]
            const clientContextSent = Buffer.from(receivedContext, 'base64').toString('utf-8')
            const injectedTraceData = JSON.parse(clientContextSent).custom
            const spanContext = tracer.extract('text_map', injectedTraceData)

            assert.strictEqual(span.resource.startsWith('invoke'), true)
            assertObjectContains(span.meta, {
              functionname: 'ironmaiden',
              aws_service: 'Lambda',
              region: 'us-east-1',
            })
            const parentId = span.span_id.toString()
            const traceId = span.trace_id.toString()
            assert.strictEqual(spanContext.toTraceId(), traceId)
            assert.strictEqual(spanContext.toSpanId(), parentId)
          }, { timeoutMs: 10000 }).then(done, done)

          lambda.invoke({
            FunctionName: 'ironmaiden',
            Payload: '{}',
            ClientContext: createClientContext({ custom: { megadeth: 'tornado of souls' } }),
          }, (e, data) => {
            receivedContext = parsePayload(data.Payload).client_context
            e && done(e)
          })
        })

        it('should propagate the tracing context with existing ClientContext and no `custom` key', (done) => {
          let receivedContext

          agent.assertSomeTraces(traces => {
            const span = traces[0][0]
            const clientContextSent = Buffer.from(receivedContext, 'base64').toString('utf-8')
            const injectedTraceData = JSON.parse(clientContextSent).custom
            const spanContext = tracer.extract('text_map', injectedTraceData)

            assert.strictEqual(span.resource.startsWith('invoke'), true)

            const parentId = span.span_id.toString()
            const traceId = span.trace_id.toString()
            assert.strictEqual(spanContext.toTraceId(), traceId)
            assert.strictEqual(spanContext.toSpanId(), parentId)
          }, { timeoutMs: 10000 }).then(done, done)

          lambda.invoke({
            FunctionName: 'ironmaiden',
            Payload: '{}',
            ClientContext: createClientContext({ megadeth: 'tornado of souls' }),
          }, (e, data) => {
            receivedContext = parsePayload(data.Payload).client_context
            e && done(e)
          })
        })

        it('should propagate the tracing context without an existing ClientContext', (done) => {
          let receivedContext

          agent.assertSomeTraces(traces => {
            const span = traces[0][0]
            const clientContextSent = Buffer.from(receivedContext, 'base64').toString('utf-8')
            const injectedTraceData = JSON.parse(clientContextSent).custom
            const spanContext = tracer.extract('text_map', injectedTraceData)

            assert.strictEqual(span.resource.startsWith('invoke'), true)

            const parentId = span.span_id.toString()
            const traceId = span.trace_id.toString()
            assert.strictEqual(spanContext.toTraceId(), traceId)
            assert.strictEqual(spanContext.toSpanId(), parentId)
          }, { timeoutMs: 10000 }).then(done, done)

          lambda.invoke({
            FunctionName: 'ironmaiden',
            Payload: '{}',
          }, (e, data) => {
            receivedContext = parsePayload(data.Payload).client_context
            e && done(e)
          })
        })
      })
    })
  })
})
