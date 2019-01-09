'use strict'

const semver = require('semver')
const agent = require('./agent')
const plugin = require('../../src/plugins/winston')

wrapIt()

describe('Plugin', () => {
  let winston
  let tracer
  let transport
  let span

  function setup (version) {
    span = tracer.startSpan('test')

    winston = require(`../../versions/winston@${version}`).get()

    class Transport extends winston.Transport {}

    Transport.prototype.log = sinon.spy()

    transport = new Transport()

    if (winston.configure) {
      winston.configure({
        transports: [transport]
      })
    } else {
      winston.add(Transport)
      winston.remove(winston.transports.Console)
    }
  }

  describe('winston', () => {
    withVersions(plugin, 'winston', version => {
      beforeEach(() => {
        tracer = require('../..')
      })

      afterEach(() => {
        return agent.close()
      })

      describe('without configuration', () => {
        beforeEach(() => {
          return agent.load(plugin, 'winston')
            .then(() => {
              setup(version)
            })
        })

        it('should not alter the default behavior', () => {
          const meta = {
            'dd.trace_id': span.context().toTraceId(),
            'dd.span_id': span.context().toSpanId()
          }

          tracer.scopeManager().activate(span)

          winston.info('message')

          if (semver.intersects(version, '>=3')) {
            expect(transport.log).to.not.have.been.calledWithMatch(meta)
          } else {
            expect(transport.log).to.not.have.been.calledWithMatch('info', 'message', meta)
          }
        })
      })

      describe('with configuration', () => {
        beforeEach(() => {
          return agent.load(plugin, 'winston', { correlate: true })
            .then(() => {
              setup(version)
            })
        })

        it('should add the trace identifiers to the default logger', () => {
          const meta = {
            'dd.trace_id': span.context().toTraceId(),
            'dd.span_id': span.context().toSpanId()
          }

          tracer.scopeManager().activate(span)

          winston.info('message')

          if (semver.intersects(version, '>=3')) {
            expect(transport.log).to.have.been.calledWithMatch(meta)
          } else {
            expect(transport.log).to.have.been.calledWithMatch('info', 'message', meta)
          }
        })

        it('should add the trace identifiers to logger instances', () => {
          const options = {
            transports: [transport]
          }

          const meta = {
            'dd.trace_id': span.context().toTraceId(),
            'dd.span_id': span.context().toSpanId()
          }

          const logger = winston.createLogger
            ? winston.createLogger(options)
            : new winston.Logger(options)

          tracer.scopeManager().activate(span)

          logger.info('message')

          if (semver.intersects(version, '>=3')) {
            expect(transport.log).to.have.been.calledWithMatch(meta)
          } else {
            expect(transport.log).to.have.been.calledWithMatch('info', 'message', meta)
          }
        })

        if (semver.intersects(version, '>=3')) {
          it('should add the trace identifiers when streaming', () => {
            const logger = winston.createLogger({
              transports: [transport]
            })

            tracer.scopeManager().activate(span)

            logger.write({
              level: 'info',
              message: 'message'
            })

            expect(transport.log).to.have.been.calledWithMatch({
              'dd.trace_id': span.context().toTraceId(),
              'dd.span_id': span.context().toSpanId()
            })
          })
        }
      })
    })
  })
})
