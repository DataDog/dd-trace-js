'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')
const { TEXT_MAP } = require('../../../ext/formats')
const { addMetadataTags, getFilter, getMethodMetadata } = require('./util')

class GrpcClientPlugin extends ClientPlugin {
  static get name () { return 'grpc' }

  start ({ metadata, path, type }) {
    const metadataFilter = this.config.metadataFilter
    const method = getMethodMetadata(path, type)
    const span = this.startSpan('grpc.client', {
      service: this.config.service,
      resource: path,
      kind: 'client',
      type: 'http',
      meta: {
        'component': 'grpc',
        'grpc.method.kind': method.type,
        'grpc.method.path': method.path,
        'grpc.method.name': method.name,
        'grpc.method.service': method.service,
        'grpc.method.package': method.package
      },
      metrics: {
        'grpc.status.code': 0
      }
    })

    if (metadata) {
      addMetadataTags(span, metadata, metadataFilter, 'request')
      inject(this.tracer, span, metadata)
    }
  }

  error (error) {
    const span = this.activeSpan

    if (!span) return

    this.addCode(span, error.code)
    this.addError(error)
  }

  finish ({ code, metadata }) {
    const span = this.activeSpan

    if (!span) return

    const metadataFilter = this.config.metadataFilter

    this.addCode(span, code)

    if (metadata && metadataFilter) {
      addMetadataTags(span, metadata, metadataFilter, 'response')
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

function inject (tracer, span, metadata) {
  if (typeof metadata.set !== 'function') return

  const carrier = {}

  tracer.inject(span, TEXT_MAP, carrier)

  for (const key in carrier) {
    metadata.set(key, carrier[key])
  }
}

module.exports = GrpcClientPlugin
