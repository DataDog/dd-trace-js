'use strict'

const http = require('http')
const https = require('https')

let agents

module.exports = config => agents || (agents = {
  httpAgent: new http.Agent({ keepAlive: true, lookup: config.lookup }),
  httpsAgent: new https.Agent({ keepAlive: true, lookup: config.lookup })
})
