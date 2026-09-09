'use strict'

const tracer = require('dd-trace')

tracer.init({
  startupLogs: false,
  url: process.env.DD_TRACE_AGENT_URL,
  flushInterval: 10,
})

const http = require('node:http')
const express = require('express')

const finish = require('./finish')

const app = express()

app.get('/user/:id', (request, response) => {
  response.send(request.params.id)
})

const server = app.listen(0, () => {
  const { port } = server.address()

  http.get(`http://127.0.0.1:${port}/user/123`, response => {
    response.resume()
    response.once('end', () => server.close(finish))
  }).once('error', error => {
    // eslint-disable-next-line no-console
    console.error(error)
    process.exit(1)
  })
})
