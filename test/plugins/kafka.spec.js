'use strict'

const agent = require('./agent')
const plugin = require('../../src/plugins/kafka-node')

wrapIt()

describe('Plugin', () => {
  let tracer
  let kafka
  let client

  describe('kafka-node', () => {
    withVersions(plugin, 'kafka-node', version => {
      beforeEach(() => {
        tracer = require('../..')
      })

      afterEach(() => {
        agent.close()
        agent.wipe()
        client.close()
      })

      beforeEach(() => {
        return agent.load(plugin, 'kafka-node')
          .then(() => {
            kafka = require(`./versions/kafka-node@${version}`).get()
          })
      })

      beforeEach(done => {
        client = new kafka.KafkaClient({
          kafkaHost: 'localhost:9092',
          connectTimeout: 1000,
          connectRetryOptions: { retries: 0 }
        })

        client.on('connect', done)
      })

      describe('when publishing messages', () => {
        let producer

        beforeEach(done => {
          producer = new kafka.Producer(client)
          producer.on('ready', () => done())
          producer.on('error', done)
        })

        it('should do automatic instrumentation on routes', done => {
          // agent
          //   .use(traces => {
          //     expect(traces[0][0]).to.have.property('name', 'kafka.request')
          //     expect(traces[0][0]).to.have.property('service', 'test')
          //     expect(traces[0][0]).to.have.property('type', 'http')
          //     expect(traces[0][0]).to.have.property('resource', 'GET /user/{id}')
          //     expect(traces[0][0].meta).to.have.property('span.kind', 'server')
          //     expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/user/123`)
          //     expect(traces[0][0].meta).to.have.property('http.method', 'GET')
          //     expect(traces[0][0].meta).to.have.property('http.status_code', '200')
          //   })
          //   .then(done)
          //   .catch(done)

          producer.send([{
            topic: 'test.topic',
            messages: 'message'
          }], done)
        })
      })
    })
  })
})
