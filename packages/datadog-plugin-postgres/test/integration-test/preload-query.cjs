'use strict'

const path = require('node:path')

// eslint-disable-next-line n/no-missing-require
const entrypoint = require.resolve('postgres')
require(path.join(path.dirname(entrypoint), 'query.js'))
