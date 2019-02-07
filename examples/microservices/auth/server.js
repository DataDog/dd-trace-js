'use strict'

const logger = require('./src/logger')
const tracer = require('dd-trace').init({ logger })
const app = require('./src/app')

app.listen(8080)
