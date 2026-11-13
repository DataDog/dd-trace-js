'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

describe('pino-pretty', () => {
  withVersions('pino', 'pino-pretty', version => {
    let format
    let tracer

    beforeEach(async () => {
      await agent.load('pino', { logInjection: true })
      tracer = require('../../dd-trace')
      const pretty = require(`../../../versions/pino-pretty@${version}`).get()
      const factory = pretty.prettyFactory ?? pretty
      const formatter = factory({ colorize: false })
      const pino = require('../../../versions/pino').get()
      let record
      const logger = pino({ base: { v: 1 } }, {
        /** @param {string} line */
        write (line) { record = line },
      })
      format = () => {
        logger.info('message')
        return formatter(record)
      }
    })

    afterEach(() => agent.close())

    it('formats a log without an active span', () => {
      const output = format()

      assert.match(output, /message/)
      assert.doesNotMatch(output, /trace_id|span_id/)
    })

    it('injects the active span into formatted output', () => {
      const span = tracer.startSpan('test')
      try {
        const output = tracer.scope().activate(span, format)

        assert.match(output, /message/)
        assert.ok(output.includes(span.context().toTraceId(true)), `Pretty ${version}: ${output}`)
        assert.ok(output.includes(span.context().toSpanId()))
      } finally {
        span.finish()
      }
    })
  })
})
