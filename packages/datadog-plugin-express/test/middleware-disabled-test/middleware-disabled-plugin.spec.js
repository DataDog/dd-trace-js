'use strict'

const test = require('./middleware-disabled-tests')

test('plugin', [{ middleware: false }, { client: false }], {})
