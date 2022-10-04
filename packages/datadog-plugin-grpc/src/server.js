'use strict'

const ServerPlugin = require('../../dd-trace/src/plugins/server')
const { TEXT_MAP } = require('../../../ext/formats')
const { addMetadataTags, getFilter, getMethodMetadata } = require('./util')

class GrpcServerPlugin extends ServerPlugin {
  static get name () { return 'grpc' }
  static get operation () { return 'server:request' }

  constructor (...args) {
    super(...args)

    this.addTraceSub('update', ({ code }) => {
      const span = this.activeSpan

      if (!span) return

      this.addCode(span, code)
    })
  }

  start ({ name, metadata, type }) {
    const metadataFilter = this.config.metadataFilter
    const childOf = extract(this.tracer, metadata)
    const method = getMethodMetadata(name, type)
    const span = this.startSpan('grpc.server', {
      childOf,
      service: this.config.service,
      resource: name,
      kind: 'server',
      type: 'web',
      meta: {
        'component': 'grpc',
        'grpc.method.kind': method.kind,
        'grpc.method.path': method.path,
        'grpc.method.name': method.name,
        'grpc.method.service': method.service,
        'grpc.method.package': method.package
      },
      metrics: {
        'grpc.status.code': 0
      }
    })

    addMetadataTags(span, metadata, metadataFilter, 'request')
  }

  error (error) {
    const span = this.activeSpan

    if (!span) return

    this.addCode(span, error.code)
    this.addError(error)
  }

  finish ({ code, trailer } = {}) {
    const span = this.activeSpan

    if (!span) return

    const metadataFilter = this.config.metadataFilter

    this.addCode(span, code)

    if (trailer && metadataFilter) {
      addMetadataTags(span, trailer, metadataFilter, 'response')
    }

    span.finish()
  }

  configure (config) {
    const metadataFilter = getFilter(config, 'metadata')

    return super.configure({ ...config, metadataFilter })
  }

  addCode (span, code) {
    if (code !== undefined) {
      span.setTag('grpc.status.code', code)
    }
  }
}

function extract (tracer, metadata) {
  if (!metadata || typeof metadata.getMap !== 'function') return null

  return tracer.extract(TEXT_MAP, metadata.getMap())
}

module.exports = GrpcServerPlugin
