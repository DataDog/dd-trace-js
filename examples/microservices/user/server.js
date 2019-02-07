'use strict'

const logger = require('./src/logger')
require('dd-trace').init({ logger })
const app = require('./src/app')

app.listen(8080)
