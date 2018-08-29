'use strict'

const tracer = require('..').init({ flushInterval: 30000 })
const benchmark = require('./benchmark')

const suite = benchmark('dd-trace')

let operation

const small = generateString(20)
const large = generateString(2000)

suite
  .add('1 span (no tags)', {
    onStart () {
      operation = () => {
        tracer.startSpan('bench').finish()
      }
    },
    fn () {
      operation()
      tracer._tracer._recorder._writer._offset = 0 // ignore flushing
    }
  })
  .add('1 span (large tags)', {
    onStart () {
      operation = () => {
        const span = tracer.startSpan('bench')
        span.addTags({
          'tag1': large,
          'tag2': large + large,
          'tag3': large + large + large
        })
        span.finish()
      }
    },
    fn () {
      operation()
      tracer._tracer._recorder._writer._offset = 0 // ignore flushing
    }
  })
  .add('3 spans (small tags)', {
    onStart () {
      operation = () => {
        const rootSpan = tracer.startSpan('root')
        rootSpan.addTags({
          'tag1': small,
          'tag2': small,
          'tag3': small
        })

        const parentSpan = tracer.startSpan('parent', { childOf: rootSpan })
        parentSpan.addTags({
          'tag1': small,
          'tag2': small,
          'tag3': small
        })

        const childSpan = tracer.startSpan('child', { childOf: parentSpan })
        childSpan.addTags({
          'tag1': small,
          'tag2': small,
          'tag3': small
        })

        childSpan.finish()
        parentSpan.finish()
        rootSpan.finish()
      }
    },
    fn () {
      operation()
      tracer._tracer._recorder._writer._offset = 0 // ignore flushing
    }
  })

suite.run()

function generateString (charCount) {
  const chars = 'abcdef0123456789'

  let result = ''

  for (let i = 0; i < charCount; i++) {
    result += chars[Math.floor(Math.random() * 15) + 1]
  }

  return result
}
