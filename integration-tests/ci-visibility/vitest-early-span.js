'use strict'

const tracer = require('dd-trace')
const { channel } = require('dc-polyfill')

// Force a payload to start before Vitest's async library configuration adds metadata tags.
channel('ci:vitest:session:start').subscribe(() => {
  const span = tracer.startSpan('vitest.early.span')
  span.finish()
})
