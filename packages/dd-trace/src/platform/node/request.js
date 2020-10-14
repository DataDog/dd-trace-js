'use strict'

const semver = require('semver')
const containerInfo = require('container-info').sync() || {}
const platform = require('../../platform')

const containerId = containerInfo.containerId
const undiciWorks = semver.satisfies(process.versions.node, '^10.16.0 || ^12.3.0 || ^14.0.0')

let requestImpl

function request (options = {}, callback) {
  if (!options.headers) {
    options.headers = {}
  }
  if (!options.protocol) {
    options.protocol = 'http:'
  }
  if (!options.hostname) {
    options.hostname = 'localhost'
  }
  if (!options.port) {
    options.port = options.protocol === 'https:' ? 443 : 80
  }
  if (containerId) {
    options.headers['Datadog-Container-ID'] = containerId
  }
  if (!requestImpl) setRequestImpl()
  return requestImpl.call(this, options, callback)
}

function setRequestImpl () {
  if (
    undiciWorks && platform._config.experimental.undici
  ) {
    requestImpl = require('./request/undici')
  } else {
    requestImpl = require('./request/http')
  }
}

module.exports = request
