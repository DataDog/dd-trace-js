'use strict'

const {
  EVP_SUBDOMAIN_HEADER_NAME,
  EVP_SUBDOMAIN_HEADER_VALUE,
  EVP_PROXY_AGENT_ENDPOINT
} = require('../../constants/writers')
const LLMObsBaseSpanWriter = require('./base')

class LLMObsAgentProxySpanWriter extends LLMObsBaseSpanWriter {
  constructor (config) {
    super({
      intake: config.hostname || 'localhost',
      protocol: 'http:',
      endpoint: EVP_PROXY_AGENT_ENDPOINT,
      port: config.port
    })

    this._headers[EVP_SUBDOMAIN_HEADER_NAME] = EVP_SUBDOMAIN_HEADER_VALUE
  }
}

module.exports = LLMObsAgentProxySpanWriter
