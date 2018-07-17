'use strict'

const tracer = require('..').init()
const benchmark = require('./benchmark')

const suite = benchmark('dd-trace')

let operation

const str = generateString(2000)

suite
  .add('1 span (no tags)', {
    onStart () {
      operation = () => {
        tracer.startSpan('bench').finish()
      }
    },
    fn () {
      operation()
    }
  })
  .add('1 span (large tags)', {
    onStart () {
      operation = () => {
        const span = tracer.startSpan('bench')
        span.addTags({
          'tag1': str + generateString(10),
          'tag2': str + str + generateString(10),
          'tag3': str + str + str + generateString(10)
        })
        span.finish()
      }
    },
    fn () {
      operation()
    }
  })
  .add('3 spans (small tags)', {
    onStart () {
      operation = () => {
        const rootSpan = tracer.startSpan('root')
        rootSpan.addTags({
          'tag1': generateString(20),
          'tag2': generateString(20),
          'tag3': generateString(20)
        })

        const parentSpan = tracer.startSpan('parent', { childOf: rootSpan })
        parentSpan.addTags({
          'tag1': generateString(20),
          'tag2': generateString(20),
          'tag3': generateString(20)
        })

        const childSpan = tracer.startSpan('child', { childOf: parentSpan })
        childSpan.addTags({
          'tag1': generateString(20),
          'tag2': generateString(20),
          'tag3': generateString(20)
        })

        childSpan.finish()
        parentSpan.finish()
        rootSpan.finish()
      }
    },
    fn () {
      operation()
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
