'use strict'

const id = require('../../packages/dd-trace/src/id')

id()
process.send('ready')
