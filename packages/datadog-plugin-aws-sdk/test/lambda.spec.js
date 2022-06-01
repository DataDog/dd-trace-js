'use strict'

const JSZip = require('jszip')
const agent = require('../../dd-trace/test/plugins/agent')
const { setup } = require('./spec_helpers')

const zip = new JSZip()

const createClientContext = data => Buffer.from(JSON.stringify(data)).toString('base64')

describe('Plugin', () => {
  describe('aws-sdk (lambda)', function () {
    setup()

    withVersions('aws-sdk', 'aws-sdk', version => {
      let AWS
      let lambda
      let tracer

      describe('with the new trace context propagation', () => {
        let ZipFile

        before(async () => {
          const lambdaFunctionCode = 'def handle(event, context):\n  return event\n'

          zip.file('handler.py', lambdaFunctionCode.toString())
          ZipFile = await zip.generateAsync({ type: 'nodebuffer' })
        })

        before(done => {
          AWS = require(`../../../versions/aws-sdk@${version}`).get()

          const lambdaEndpoint = new AWS.Endpoint('http://127.0.0.1:4566')
          lambda = new AWS.Lambda({ endpoint: lambdaEndpoint, region: 'us-east-1' })

          lambda.createFunction({
            FunctionName: 'ironmaiden',
            Code: { ZipFile },
            Handler: 'handler.handle',
            Role: 'arn:aws:iam::123456:role/test',
            Runtime: 'python3.7'
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

        it('should propagate the tracing context with existing ClientContext and `custom` key', (done) => {
          agent.use(traces => {
            const span = traces[0][0]
            const clientContextSent = Buffer.from(lambdaReq.params.ClientContext, 'base64').toString('utf-8')
            const injectedTraceData = JSON.parse(clientContextSent).custom
            const spanContext = tracer.extract('text_map', injectedTraceData)

            expect(span.resource.startsWith('invoke')).to.equal(true)

            const parentId = span.span_id.toString()
            const traceId = span.trace_id.toString()
            expect(spanContext.toTraceId()).to.equal(traceId)
            expect(spanContext.toSpanId()).to.equal(parentId)
          }).then(done, done)

          const lambdaReq = lambda.invoke({
            FunctionName: 'ironmaiden',
            Payload: '{}',
            ClientContext: createClientContext({ custom: { megadeth: 'tornado of souls' } })
          }, e => e && done(e))
        })

        it('should propagate the tracing context with existing ClientContext and no `custom` key', (done) => {
          agent.use(traces => {
            const span = traces[0][0]
            const clientContextSent = Buffer.from(lambdaReq.params.ClientContext, 'base64').toString('utf-8')
            const injectedTraceData = JSON.parse(clientContextSent).custom
            const spanContext = tracer.extract('text_map', injectedTraceData)

            expect(span.resource.startsWith('invoke')).to.equal(true)

            const parentId = span.span_id.toString()
            const traceId = span.trace_id.toString()
            expect(spanContext.toTraceId()).to.equal(traceId)
            expect(spanContext.toSpanId()).to.equal(parentId)
          }).then(done, done)

          const lambdaReq = lambda.invoke({
            FunctionName: 'ironmaiden',
            Payload: '{}',
            ClientContext: createClientContext({ megadeth: 'tornado of souls' })
          }, e => e && done(e))
        })

        it('should propagate the tracing context without an existing ClientContext', (done) => {
          agent.use(traces => {
            const span = traces[0][0]
            const clientContextSent = Buffer.from(lambdaReq.params.ClientContext, 'base64').toString('utf-8')
            const injectedTraceData = JSON.parse(clientContextSent).custom
            const spanContext = tracer.extract('text_map', injectedTraceData)

            expect(span.resource.startsWith('invoke')).to.equal(true)

            const parentId = span.span_id.toString()
            const traceId = span.trace_id.toString()
            expect(spanContext.toTraceId()).to.equal(traceId)
            expect(spanContext.toSpanId()).to.equal(parentId)
          }).then(done, done)

          const lambdaReq = lambda.invoke({
            FunctionName: 'ironmaiden',
            Payload: '{}'
          }, e => e && done(e))
        })
      })
    })
  })
})
