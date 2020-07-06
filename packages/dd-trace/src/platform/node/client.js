'use strict'

const axios = require('axios')
const agents = require('./agents')

module.exports = function (options) {
  const platform = this
  const { httpAgent, httpsAgent } = agents(platform._config)

  return axios.create(Object.assign({
    httpAgent,
    httpsAgent
  }, options))
}
