'use strict'

const http = require('http')
const https = require('https')

const createAgentClass = require('./create-agent-class')

const maxSockets = 1

const HttpAgent = createAgentClass(http.Agent, maxSockets)
const HttpsAgent = createAgentClass(https.Agent, maxSockets)

module.exports = {
  httpAgent: new HttpAgent(),
  httpsAgent: new HttpsAgent(),
}
