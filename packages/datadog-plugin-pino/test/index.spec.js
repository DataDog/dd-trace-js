'use strict'

const Writable = require('stream').Writable
const agent = require('../../dd-trace/test/plugins/agent')
const semver = require('semver')

describe('Plugin', () => {
  let logger
  let tracer
  let stream
  let span

  describe('pino', () => {
    withVersions('pino', 'pino', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
      })

      afterEach(() => {
        return agent.close({ ritmReset: false })
      })

      withExports('pino', version, ['default', 'pino'], '>=6.8.0', getExport => {
        function setup (options) {
          const pino = getExport()

          span = tracer.startSpan('test')

          stream = new Writable()
          stream._write = () => {}

          sinon.spy(stream, 'write')

          logger = pino && pino(options, stream)
        }

        describe('without configuration', () => {
          beforeEach(() => {
            return agent.load('pino')
          })

          beforeEach(function () {
            setup()

            if (!logger) {
              this.skip()
            }
          })

          it('should not alter the default behavior', () => {
            tracer.scope().activate(span, () => {
              logger.info('message')

              expect(stream.write).to.have.been.called

              const record = JSON.parse(stream.write.firstCall.args[0].toString())

              expect(record).to.not.have.property('dd')
              expect(record).to.have.deep.property('msg', 'message')
            })
          })

          if (semver.intersects(version, '>=5')) {
            it('should not alter the default behavior with pretty print', () => {
              setup({ prettyPrint: true })

              tracer.scope().activate(span, () => {
                logger.info('message')

                expect(stream.write).to.have.been.called

                const record = stream.write.firstCall.args[0].toString()

                expect(record).to.not.include('trace_id')
                expect(record).to.not.include('span_id')
                expect(record).to.include('message')
              })
            })
          }
        })

        describe('with configuration', () => {
          beforeEach(() => {
            return agent.load('pino', { logInjection: true })
          })

          beforeEach(function () {
            setup()

            if (!logger) {
              this.skip()
            }
          })

          it('should add the trace identifiers to logger instances', () => {
            tracer.scope().activate(span, () => {
              logger.info('message')

              expect(stream.write).to.have.been.called

              const record = JSON.parse(stream.write.firstCall.args[0].toString())

              expect(record.dd).to.deep.include({
                trace_id: span.context().toTraceId(),
                span_id: span.context().toSpanId()
              })

              expect(record).to.have.deep.property('msg', 'message')
            })
          })

          it('should support errors', () => {
            tracer.scope().activate(span, () => {
              const error = new Error('boom')

              logger.info(error)

              const record = JSON.parse(stream.write.firstCall.args[0].toString())

              if (record.err) { // pino >=7
                expect(record.err).to.have.property('message', error.message)
                expect(record.err).to.have.property('type', 'Error')
                expect(record.err).to.have.property('stack', error.stack)
              } else { // pino <7
                expect(record).to.have.property('msg', error.message)
                expect(record).to.have.property('type', 'Error')
                expect(record).to.have.property('stack', error.stack)
              }
            })
          })

          it('should not alter the original record', () => {
            tracer.scope().activate(span, () => {
              const record = {
                foo: 'bar'
              }

              logger.info(record)

              expect(record).to.not.have.property('dd')
            })
          })

          it('should skip injection when there is no active span', () => {
            logger.info('message')

            expect(stream.write).to.have.been.called

            const record = JSON.parse(stream.write.firstCall.args[0].toString())

            expect(record).to.not.have.property('dd')
            expect(record).to.have.deep.property('msg', 'message')
          })

          if (semver.intersects(version, '>=5.14.0')) {
            it('should not alter pino mixin behavior', () => {
              const opts = { mixin: () => ({ addedMixin: true }) }

              sinon.spy(opts, 'mixin')

              setup(opts)

              tracer.scope().activate(span, () => {
                logger.info('message')

                expect(opts.mixin).to.have.been.called

                expect(stream.write).to.have.been.called

                const record = JSON.parse(stream.write.firstCall.args[0].toString())

                expect(record.dd).to.deep.include({
                  trace_id: span.context().toTraceId(),
                  span_id: span.context().toSpanId()
                })

                expect(record).to.have.deep.property('msg', 'message')
                expect(record).to.have.deep.property('addedMixin', true)
              })
            })
          }

          // TODO: test with a version matrix against pino. externals.json doesn't allow that
          //       and we cannot control the version of pino-pretty internally required by pino
          if (semver.intersects(version, '>=5')) {
            it('should add the trace identifiers to logger instances with pretty print', () => {
              setup({ prettyPrint: true })

              tracer.scope().activate(span, () => {
                logger.info('message')

                expect(stream.write).to.have.been.called

                const record = stream.write.firstCall.args[0].toString()

                expect(record).to.match(new RegExp(`trace_id\\W+?${span.context().toTraceId()}`))
                expect(record).to.match(new RegExp(`span_id\\W+?${span.context().toSpanId()}`))

                expect(record).to.include('message')
              })
            })
          }
        })
      })
    })
  })
})
