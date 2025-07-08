'use strict'

const JSZip = require('jszip')
const { withNamingSchema, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { setup } = require('./spec_helpers')
const { rawExpectedSchema } = require('./lambda-naming')

const zip = new JSZip()

const createClientContext = data => Buffer.from(JSON.stringify(data)).toString('base64')

describe('Plugin', () => {
  describe('aws-sdk (lambda)', function () {
    setup()

    withVersions('aws-sdk', ['aws-sdk', '@aws-sdk/smithy-client'], (version, moduleName) => {
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

      describe('with the new trace context propagation', () => {
        let ZipFile

        before(async () => {
          const lambdaFunctionCode = 'exports.handle = async function (event, context) {\n  return context \n}'

          zip.file('handler.js', lambdaFunctionCode.toString())
          ZipFile = await zip.generateAsync({ type: 'nodebuffer' })
        })

        before(done => {
          AWS = require(`../../../versions/${lambdaClientName}@${version}`).get()

          lambda = new AWS.Lambda({ endpoint: 'http://127.0.0.1:4567', region: 'us-east-1' })
          lambda.createFunction({
            FunctionName: 'ironmaiden',
            Code: { ZipFile },
            Handler: 'handler.handle',
            Role: 'arn:aws:iam::123456:role/test',
            Runtime: 'nodejs18.x'
          }, (err, res) => {
            if (err) return done(err)

            agent.load('aws-sdk').then(done, done)
          })
          tracer = require('../../dd-trace')
        })

        after(done => {
          lambda.deleteFunction({ FunctionName: 'ironmaiden' }, err => {
            agent.close({ ritmReset: false }).then(() => done(err), done)
          })
        })

        withNamingSchema(
          (done) => lambda.invoke({
            FunctionName: 'ironmaiden',
            Payload: '{}',
            ClientContext: createClientContext({ custom: { megadeth: 'tornado of souls' } })
          }, (err) => err && done(err)),
          rawExpectedSchema.invoke,
          {
            desc: 'invoke'
          }
        )

        withNamingSchema(
          (done) => lambda.listFunctions({}, (err) => err && done(err)),
          rawExpectedSchema.client,
          {
            desc: 'client'
          }
        )

        it('should propagate the tracing context with existing ClientContext and `custom` key', (done) => {
          let receivedContext

          agent.assertSomeTraces(traces => {
            const span = traces[0][0]
            const clientContextSent = Buffer.from(receivedContext, 'base64').toString('utf-8')
            const injectedTraceData = JSON.parse(clientContextSent).custom
            const spanContext = tracer.extract('text_map', injectedTraceData)

            expect(span.resource.startsWith('invoke')).to.equal(true)
            expect(span.meta).to.include({
              functionname: 'ironmaiden',
              aws_service: 'Lambda',
              region: 'us-east-1'
            })
            const parentId = span.span_id.toString()
            const traceId = span.trace_id.toString()
            expect(spanContext.toTraceId()).to.equal(traceId)
            expect(spanContext.toSpanId()).to.equal(parentId)
          }).then(done, done)

          lambda.invoke({
            FunctionName: 'ironmaiden',
            Payload: '{}',
            ClientContext: createClientContext({ custom: { megadeth: 'tornado of souls' } })
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

            expect(span.resource.startsWith('invoke')).to.equal(true)

            const parentId = span.span_id.toString()
            const traceId = span.trace_id.toString()
            expect(spanContext.toTraceId()).to.equal(traceId)
            expect(spanContext.toSpanId()).to.equal(parentId)
          }).then(done, done)

          lambda.invoke({
            FunctionName: 'ironmaiden',
            Payload: '{}',
            ClientContext: createClientContext({ megadeth: 'tornado of souls' })
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

            expect(span.resource.startsWith('invoke')).to.equal(true)

            const parentId = span.span_id.toString()
            const traceId = span.trace_id.toString()
            expect(spanContext.toTraceId()).to.equal(traceId)
            expect(spanContext.toSpanId()).to.equal(parentId)
          }).then(done, done)

          lambda.invoke({
            FunctionName: 'ironmaiden',
            Payload: '{}'
          }, (e, data) => {
            receivedContext = parsePayload(data.Payload).client_context
            e && done(e)
          })
        })
      })
    })
  })
})
