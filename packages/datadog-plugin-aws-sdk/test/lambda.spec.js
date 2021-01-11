'use strict'

const JSZip = require('jszip')
const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')
const { setup } = require('./spec_helpers')

const zip = new JSZip()

wrapIt()

describe('Plugin', () => {
  describe('aws-sdk (lambda)', function () {
    setup()

    withVersions(plugin, 'aws-sdk', version => {
      let AWS
      let lambda
      let tracer

      describe('without configuration', () => {
        let ZipFile

        before(async () => {
          const lambdaFunctionCode = `exports.handle = async (event, context) => {
            return context.clientContext;
          }`

          zip.file('handler.js', lambdaFunctionCode.toString())
          ZipFile = await zip.generateAsync({ type: 'nodebuffer' })
        })

        before(done => {
          AWS = require(`../../../versions/aws-sdk@${version}`).get()

          const lambdaEndpoint = new AWS.Endpoint('http://localhost:4566')
          lambda = new AWS.Lambda({ endpoint: lambdaEndpoint, region: 'us-east-1' })

          lambda.createFunction({
            FunctionName: 'LAMBDA_FUNCTION_NAME',
            Code: { ZipFile },
            Handler: 'handler.handle',
            Role: 'arn:aws:iam::123456:role/test',
            Runtime: 'nodejs8.10'
          }, (err, res) => {
            if (err) return done(err)
            console.log('in before', err, res)
            agent.load('aws-sdk').then(done, done)
          })
          tracer = require('../../dd-trace')
        })

        after(done => {
          lambda.deleteFunction({ FunctionName: 'LAMBDA_FUNCTION_NAME' }, err => {
            console.log('in after', err)
            agent.close().then(() => done(err), done)
          })
        })

        it('should propagate the tracing context with existing ClientContext', (done) => {
          let spanContext

          agent.use(traces => {
            const span = traces[0][0]

            expect(span.resource.startsWith('invoke')).to.equal(true)

            const parentId = span.span_id.toString()
            const traceId = span.trace_id.toString()
            expect(spanContext.toTraceId()).to.equal(traceId)
            expect(spanContext.toSpanId()).to.equal(parentId)
          }).then(done, done)

          lambda.listFunctions((err, res) => {
            console.log('listfunctions res', err, res)
          })

          lambda.invoke({
            FunctionName: 'LAMBDA_FUNCTION_NAME',
            Payload: '{}',
            ClientContext: 'eyJjdXN0b20iOnsieC1jb3JyZWxhdGlvbi10ZXN0LWN1aWQiOiJja2N4NGttNXUwMDAwMGNzM2NpbzdvODJsIn19'
          }, (err, res) => {
            if (err) return done(err)

            const injectedTraceData = JSON.parse(JSON.parse(res.Payload)).custom._datadog
            spanContext = tracer.extract('text_map', injectedTraceData)
          })
        })

        it('should propagate the tracing context without an existing ClientContext', (done) => {
          let spanContext

          agent.use(traces => {
            const span = traces[0][0]

            expect(span.resource.startsWith('invoke')).to.equal(true)

            const parentId = span.span_id.toString()
            const traceId = span.trace_id.toString()
            expect(spanContext.toTraceId()).to.equal(traceId)
            expect(spanContext.toSpanId()).to.equal(parentId)
          }).then(done, done)

          lambda.invoke({
            FunctionName: 'LAMBDA_FUNCTION_NAME',
            Payload: '{}'
          }, (err, res) => {
            if (err) return done(err)

            const injectedTraceData = JSON.parse(JSON.parse(res.Payload)).custom._datadog
            spanContext = tracer.extract('text_map', injectedTraceData)
          })
        })
      })
    })
  })
})
