'use strict'

const { storage } = require('../../datadog-core')
const ServerPlugin = require('../../dd-trace/src/plugins/server')
const { TEXT_MAP } = require('../../../ext/formats')
const { addMetadataTags, getFilter, getMethodMetadata } = require('./util')

class GrpcServerPlugin extends ServerPlugin {
  static get id () { return 'grpc' }
  static get operation () { return 'server:request' }
  static get prefix () { return 'apm:grpc:server:request' }

  constructor (...args) {
    super(...args)

    this.addTraceSub('update', ({ code }) => {
      const span = this.activeSpan

      if (!span) return

      this.addCode(span, code)
    })

    this.addTraceBind('emit', ({ currentStore }) => {
      return currentStore
    })
  }

  bindStart (message) {
    const store = storage.getStore()
    const { name, metadata, type } = message
    const metadataFilter = this.config.metadataFilter
    const childOf = extract(this.tracer, metadata)
    const method = getMethodMetadata(name, type)
    const span = this.startSpan(this.operationName(), {
      childOf,
      service: this.config.service || this.serviceName(),
      resource: name,
      kind: 'server',
      type: 'web',
      meta: {
        component: 'grpc',
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

    message.span = span
    message.parentStore = store
    message.currentStore = { ...store, span }

    return message.currentStore
  }

  bindAsyncStart ({ parentStore }) {
    return parentStore
  }

  error ({ error }) {
    const span = this.activeSpan

    if (!span) return

    this.addCode(span, error.code)
    this.addError(error)
  }

  finish ({ span, code, trailer }) {
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
