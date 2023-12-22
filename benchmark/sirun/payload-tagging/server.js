'use strict'

const tracer = require('../../..')
const { port } = require('./common')

tracer.init()

const express = require('express')
const app = express()

app.post('/endpoint', (req, res) => {
  res.send('Thanks for the data')
})

app.listen(port, () => { console.log(`server listening on ${port}`) })
