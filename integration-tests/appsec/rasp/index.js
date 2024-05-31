'use strict'
require('dd-trace').init()

const http = require('https')
const express = require('express')

const app = express()
const port = process.env.APP_PORT || 3000

app.get('/ssrf/http/unhandled-error', (req, res) => {
  http.get(`https://${req.query.host}`, () => {
    res.send('Hello World!')
  })
})

app.listen(port, () => {
  process.send({ port })
})
