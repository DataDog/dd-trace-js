'use strict'

require('dd-trace').init()

const express = require('express')

const iastRouter = require('./iast')
const randomJson = require('./random.json') // eslint-disable-line no-unused-vars

const app = express()

app.use('/iast', iastRouter)

const server = app.listen(0, () => {
  process.send?.({ port: server.address().port })
})
