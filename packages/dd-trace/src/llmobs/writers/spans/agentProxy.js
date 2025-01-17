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
      intake: config.url?.hostname || config.hostname || 'localhost',
      protocol: config.url?.protocol || 'http:',
      endpoint: EVP_PROXY_AGENT_ENDPOINT,
      port: config.url?.port || config.port
    })

    this._headers[EVP_SUBDOMAIN_HEADER_NAME] = EVP_SUBDOMAIN_HEADER_VALUE
  }
}

module.exports = LLMObsAgentProxySpanWriter
