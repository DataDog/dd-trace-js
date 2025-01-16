'use strict'

const test = require('./middleware-disabled-tests')

test('tracer', [{}, { client: false }], { middleware: false })
