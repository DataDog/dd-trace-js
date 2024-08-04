'use strict'

require('./middleware/context').enable()

if (process.env.DD_TRACING_ENABLED !== 'false') {
  require('./middleware/tracing').enable()
}
