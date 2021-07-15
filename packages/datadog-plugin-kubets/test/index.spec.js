'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')

wrapIt()

describe('Plugin', () => {
  let tracer
  let connection
  let channel

  describe('amqplib', () => {
    withVersions(plugin, 'amqplib', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
      })

      afterEach(() => {
        connection.close()
      })

      describe('without configuration', () => {
        before(() => {
          return agent.load(plugin, 'amqplib')
        })

        after(() => {
          return agent.close()
        })

        describe('when using a callback', () => {
          beforeEach(done => {
            require(`../../../versions/amqplib@${version}`).get('amqplib/callback_api')
              .connect((err, conn) => {
                connection = conn

                if (err != null) {
                  return done(err)
                }

                conn.createChannel((err, ch) => {
                  channel = ch
                  done(err)
                })
              })
          })

          describe('when sending commands', () => {
            it('should do automatic instrumentation for immediate commands', done => {
              agent
                .use(traces => {
                  const span = traces[0][0]

                  expect(span).to.have.property('name', 'amqp.command')
                  expect(span).to.have.property('service', 'test-amqp')
                  expect(span).to.have.property('resource', 'queue.declare test')
                  expect(span).to.have.property('type', 'worker')
                  expect(span.meta).to.have.property('out.host', 'localhost')
                  expect(span.metrics).to.have.property('out.port', 5672)
                }, 2)
                .then(done)
                .catch(done)

              channel.assertQueue('test', {}, () => {})
            })

            it('should do automatic instrumentation for queued commands', done => {
              agent
                .use(traces => {
                  const span = traces[0][0]

                  expect(span).to.have.property('name', 'amqp.command')
                  expect(span).to.have.property('service', 'test-amqp')
                  expect(span).to.have.property('resource', 'queue.delete test')
                  expect(span).to.have.property('type', 'worker')
                  expect(span.meta).to.have.property('out.host', 'localhost')
                  expect(span.metrics).to.have.property('out.port', 5672)
                }, 3)
                .then(done)
                .catch(done)

              channel.assertQueue('test', {}, () => {})
              channel.deleteQueue('test', () => {})
            })

            it('should handle errors', done => {
              let error

              agent
                .use(traces => {
                  const span = traces[0][0]

                  expect(span).to.have.property('error', 1)
                  expect(span.meta).to.have.property('error.type', error.name)
                  expect(span.meta).to.have.property('error.msg', error.message)
                  expect(span.meta).to.have.property('error.stack', error.stack)
                }, 2)
                .then(done)
                .catch(done)

              try {
                channel.deleteQueue(null, () => {})
              } catch (e) {
                error = e
              }
            })
          })

          describe('when publishing messages', () => {
            it('should do automatic instrumentation', done => {
              agent
                .use(traces => {
                  const span = traces[0][0]

                  expect(span).to.have.property('name', 'amqp.command')
                  expect(span).to.have.property('service', 'test-amqp')
                  expect(span).to.have.property('resource', 'basic.publish exchange routingKey')
                  expect(span).to.have.property('type', 'worker')
                  expect(span.meta).to.have.property('out.host', 'localhost')
                  expect(span.meta).to.have.property('span.kind', 'producer')
                  expect(span.meta).to.have.property('amqp.routingKey', 'routingKey')
                  expect(span.metrics).to.have.property('out.port', 5672)
                }, 3)
                .then(done)
                .catch(done)

              channel.assertExchange('exchange', 'direct', {}, () => {})
              channel.publish('exchange', 'routingKey', Buffer.from('content'))
            })

            it('should handle errors', done => {
              let error

              agent
                .use(traces => {
                  const span = traces[0][0]

                  expect(span).to.have.property('error', 1)
                  expect(span.meta).to.have.property('error.type', error.name)
                  expect(span.meta).to.have.property('error.msg', error.message)
                  expect(span.meta).to.have.property('error.stack', error.stack)
                }, 2)
                .then(done)
                .catch(done)

              try {
                channel.sendToQueue('test', 'invalid')
              } catch (e) {
                error = e
              }
            })
          })

          describe('when consuming messages', () => {
            it('should do automatic instrumentation', done => {
              let consumerTag
              let queue

              agent
                .use(traces => {
                  const span = traces[0][0]

                  expect(span).to.have.property('name', 'amqp.command')
                  expect(span).to.have.property('service', 'test-amqp')
                  expect(span).to.have.property('resource', `basic.deliver ${queue}`)
                  expect(span).to.have.property('type', 'worker')
                  expect(span.meta).to.have.property('out.host', 'localhost')
                  expect(span.meta).to.have.property('span.kind', 'consumer')
                  expect(span.meta).to.have.property('amqp.consumerTag', consumerTag)
                  expect(span.metrics).to.have.property('out.port', 5672)
                }, 5)
                .then(done)
                .catch(done)

              channel.assertQueue('', {}, (err, ok) => {
                if (err) return done(err)

                queue = ok.queue

                channel.sendToQueue(ok.queue, Buffer.from('content'))
                channel.consume(ok.queue, () => {}, {}, (err, ok) => {
                  if (err) return done(err)
                  consumerTag = ok.consumerTag
                })
              })
            })

            it('should run the command callback in the parent context', done => {
              if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

              channel.assertQueue('', {}, (err, ok) => {
                if (err) return done(err)

                channel.consume(ok.queue, () => {}, {}, () => {
                  expect(tracer.scope().active()).to.be.null
                  done()
                })
              })
            })

            it('should run the delivery callback in the current context', done => {
              if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

              channel.assertQueue('', {}, (err, ok) => {
                if (err) return done(err)

                channel.sendToQueue(ok.queue, Buffer.from('content'))
                channel.consume(ok.queue, () => {
                  expect(tracer.scope().active()).to.not.be.null
                  done()
                }, {}, err => err && done(err))
              })
            })
          })
        })

        describe('when using a promise', () => {
          beforeEach(() => {
            return require(`../../../versions/amqplib@${version}`).get().connect()
              .then(conn => (connection = conn))
              .then(conn => conn.createChannel())
              .then(ch => (channel = ch))
          })

          it('should run the callback in the parent context', done => {
            if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

            channel.assertQueue('test', {})
              .then(() => {
                expect(tracer.scope().active()).to.be.null
                done()
              })
              .catch(done)
          })
        })
      })

      describe('with configuration', () => {
        before(() => {
          return agent.load(plugin, 'amqplib', { service: 'test' })
        })

        after(() => {
          return agent.close()
        })

        beforeEach(done => {
          require(`../../../versions/amqplib@${version}`).get('amqplib/callback_api')
            .connect((err, conn) => {
              connection = conn

              if (err !== null) {
                return done(err)
              }

              conn.createChannel((err, ch) => {
                channel = ch
                done(err)
              })
            })
        })

        it('should be configured with the correct values', done => {
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('service', 'test')
              expect(traces[0][0]).to.have.property('resource', 'queue.declare test')
            }, 2)
            .then(done)
            .catch(done)

          channel.assertQueue('test', {}, () => {})
        })
      })
    })
  })
})
