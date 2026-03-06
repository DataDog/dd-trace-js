'use strict'

const http = require('http')
const https = require('https')
const { storage } = require('../../../../datadog-core')

const keepAlive = true
const maxSockets = 1

function createAgentClass (BaseAgent) {
  class CustomAgent extends BaseAgent {
    constructor () {
      super({ keepAlive, maxSockets })
    }

    createConnection (...args) {
      return this.#noop(() => super.createConnection(...args))
    }

    keepSocketAlive (...args) {
      return this.#noop(() => super.keepSocketAlive(...args))
    }

    reuseSocket (...args) {
      return this.#noop(() => super.reuseSocket(...args))
    }

    #noop (callback) {
      return storage('legacy').run({ noop: true }, callback)
    }
  }

  return CustomAgent
}

const HttpAgent = createAgentClass(http.Agent)
const HttpsAgent = createAgentClass(https.Agent)

module.exports = {
  httpAgent: new HttpAgent(),
  httpsAgent: new HttpsAgent(),
}
