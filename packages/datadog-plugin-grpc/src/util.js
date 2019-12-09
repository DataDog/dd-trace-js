'use strict'

const pick = require('lodash.pick')
const log = require('../../dd-trace/src/log')

module.exports = {
  addMethodTags (span, path, kind) {
    if (typeof path !== 'string') return

    span.addTags({
      'grpc.method.path': path,
      'grpc.method.kind': kind
    })

    const methodParts = path.split('/')

    if (methodParts.length < 2) return

    const serviceParts = methodParts[1].split('.')
    const name = methodParts[2]
    const service = serviceParts.pop()
    const pkg = serviceParts.join('.')

    span.addTags({
      'grpc.method.name': name,
      'grpc.method.service': service,
      'grpc.method.package': pkg
    })
  },

  addMetadataTags (span, metadata, filter, type) {
    if (!metadata || typeof metadata.getMap !== 'function') return

    const values = filter(metadata.getMap())

    for (const key in values) {
      span.setTag(`grpc.${type}.metadata.${key}`, values[key])
    }
  },

  // TODO: extract this to shared utils and add unit tests
  getFilter (config, filter) {
    if (typeof config[filter] === 'function') {
      return config[filter]
    }

    if (config[filter] instanceof Array) {
      return element => pick(element, config[filter])
    }

    if (config.hasOwnProperty(filter)) {
      log.error(`Expected '${filter}' to be an array or function.`)
    }

    return () => ({})
  }
}
