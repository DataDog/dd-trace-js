'use strict'

const { tracer } = require('../../../../packages/datadog-tracer')

setInterval(() => tracer.flush(), 2000).unref()

require('./patch')
require('./storage')
require('./trace')
