'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')
const { setup } = require('./spec_helpers')
const getPort = require('get-port')
const http = require('http')
const { response } = require('express')

const topicOptions = {
  Name: 'SNS_TOPIC_NAME'
}

describe('Plugin', () => {
  describe('aws-sdk (sns)', function () {
    setup()

    withVersions(plugin, 'aws-sdk', version => {
      let AWS
      let sns
      let TopicArn
      let tracer
      let result
      let server

      describe('without configuration', () => {
        before(() => {
          tracer = require('../../dd-trace')

          return agent.load('aws-sdk')
        })

        before(done => {
          AWS = require(`../../../versions/aws-sdk@${version}`).get()

          const endpoint = new AWS.Endpoint('http://localhost:4575')

          sns = new AWS.SNS({ endpoint, region: 'us-east-1' })
          sns.createTopic(topicOptions, (err, res) => {
            if (err) return done(err)
            TopicArn = res.TopicArn

            server = http.createServer((req, res) => {
              let data = ''
              req.on('data', chunk => {
                console.log('GOT CHUNK')
                data += chunk
              })
              req.on('end', () => {
                console.log(JSON.parse(data))
                result = data
                res.end()
              })
            }).listen(7777)
            sns.subscribe({
              Protocol: 'http',
              TopicArn,
              Endpoint: `localhost:7777`
            }, (err, res) => {
              console.log('SUBSCRIBE RETURNED', res)
              done()
            })
          })
        })

        after(done => {
          server.close()
          sns.deleteTopic({ TopicArn }, done)
        })

        after(() => {
          return agent.close()
        })

        it('should propagate the tracing context from the producer to the consumer', (done) => {
          let parentId
          let traceId

          // agent.use(traces => {
          //   const span = traces[0][0]

          //   expect(span.resource.startsWith('publish')).to.equal(true)

          //   parentId = span.span_id.toString()
          //   traceId = span.trace_id.toString()
          // })

          // agent.use(traces => {
          //   const span = traces[0][0]
          //   console.log("TRACES", traces)
          //   expect(parentId).to.be.a('string')
          //   expect(span.parent_id.toString()).to.equal(parentId)
          //   expect(span.trace_id.toString()).to.equal(traceId)
          // }).then(done, done)

          sns.publish({
            Message: 'test body',
            TopicArn
          }, (err, res) => {
            if (err) return done(err)
            console.log('publish res', res)
            console.log(`GOT RESULT`, result)
            const data = new TextEncoder().encode(
              JSON.stringify({
                todo: 'Buy the milk 🍼'
              })
            )
            const options = {
              hostname: 'localhost',
              port: 7777,
              path: '/',
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': data.length
              }
            }

            const req = http.request(options, res => {
              console.log(`statusCode: ${res.statusCode}`)

              res.on('data', d => {
                process.stdout.write(d)
              })
            })

            req.on('error', error => {
              console.log('errror')
              console.error(error)
            })

            req.write(data)
            req.end()
            done()
          })
        })
      })
    })
  })
})
