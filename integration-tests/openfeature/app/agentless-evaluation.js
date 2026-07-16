'use strict'

const tracer = require('dd-trace')
const http = require('node:http')
const { OpenFeature } = require('@openfeature/server-sdk')

tracer.init({
  env: 'integration',
  service: 'ffe-agentless-integration',
})

OpenFeature.setProvider(tracer.openfeature)
const client = OpenFeature.getClient()

const server = http.createServer((request, response) => {
  if (request.url !== '/evaluate') {
    response.writeHead(404).end()
    return
  }

  client.getStringDetails('agentless-integration-flag', 'default', {
    targetingKey: 'integration-user',
  }).then(details => {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(details))
  }, error => {
    response.writeHead(500, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: error.message }))
  })
})

server.listen(0, function () {
  process.send?.({ port: this.address().port })
})
