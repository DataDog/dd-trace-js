'use strict'

const Writable = require('node:stream').Writable
const { withExports, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const semver = require('semver')
const { NODE_MAJOR } = require('../../../version')

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
        function setupTest (options = {}) {
          const pino = getExport()

          span = tracer.startSpan('test')

          stream = new Writable()
          stream._write = () => {}

          sinon.spy(stream, 'write')

          if (semver.intersects(version, '>=8') && options.prettyPrint) {
            delete options.prettyPrint // deprecated

            const pretty = require('../../../versions/pino-pretty@8.0.0').get()

            stream = pretty().pipe(stream)
          }

          logger = pino && pino(options, stream)
        }

        describe('without configuration', () => {
          beforeEach(() => {
            return agent.load('pino')
          })

          beforeEach(function () {
            setupTest()

            if (!logger) {
              this.skip()
            }
          })

          it('should not alter the default behavior', () => {
            tracer.scope().activate(span, () => {
              logger.info('message')

              expect(stream.write).to.have.been.called

              const record = JSON.parse(stream.write.firstCall.args[0].toString())

              expect(record).to.have.property('dd')
              expect(record).to.have.deep.property('msg', 'message')
            })
          })

          if (semver.intersects(version, '>=5')) {
            it('should not alter the default behavior with pretty print', () => {
              setupTest({ prettyPrint: true })

              tracer.scope().activate(span, () => {
                logger.info('message')

                expect(stream.write).to.have.been.called

                const record = stream.write.firstCall.args[0].toString()

                expect(record).to.include('trace_id')
                expect(record).to.include('span_id')
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
            setupTest()

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
                trace_id: span.context().toTraceId(true),
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
                // ** TODO ** add this back once we fix it
                if (NODE_MAJOR < 21) {
                  expect(record).to.have.property('type', 'Error')
                  expect(record).to.have.property('stack', error.stack)
                }
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

          it('should not inject trace_id or span_id without an active span', () => {
            logger.info('message')

            expect(stream.write).to.have.been.called

            const record = JSON.parse(stream.write.firstCall.args[0].toString())

            expect(record).to.have.property('dd')
            expect(record.dd).to.not.have.property('trace_id')
            expect(record.dd).to.not.have.property('span_id')
            expect(record).to.have.deep.property('msg', 'message')
          })

          if (semver.intersects(version, '>=5.14.0')) {
            it('should not alter pino mixin behavior', () => {
              const opts = { mixin: () => ({ addedMixin: true }) }

              sinon.spy(opts, 'mixin')

              setupTest(opts)

              tracer.scope().activate(span, () => {
                logger.info('message')

                expect(opts.mixin).to.have.been.called

                expect(stream.write).to.have.been.called

                const record = JSON.parse(stream.write.firstCall.args[0].toString())

                expect(record.dd).to.deep.include({
                  trace_id: span.context().toTraceId(true),
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
              setupTest({ prettyPrint: true })

              tracer.scope().activate(span, () => {
                logger.info('message')

                expect(stream.write).to.have.been.called

                const record = stream.write.firstCall.args[0].toString()

                expect(record).to.match(new RegExp(`trace_id\\W+?${span.context().toTraceId(true)}`))
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
