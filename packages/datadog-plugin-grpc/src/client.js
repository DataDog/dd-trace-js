'use strict'

const { storage } = require('../../datadog-core')
const ClientPlugin = require('../../dd-trace/src/plugins/client')
const { TEXT_MAP } = require('../../../ext/formats')
const { addMetadataTags, getFilter, getMethodMetadata } = require('./util')

class GrpcClientPlugin extends ClientPlugin {
  static get id () { return 'grpc' }
  static get operation () { return 'client:request' }
  static get prefix () { return 'apm:grpc:client:request' }
  static get peerServicePrecursors () { return ['rpc.service'] }

  constructor (...args) {
    super(...args)

    this.addTraceBind('emit', ({ parentStore }) => {
      return parentStore
    })
  }

  bindStart (message) {
    const store = storage.getStore()
    const { metadata, path, type } = message
    const metadataFilter = this.config.metadataFilter
    const method = getMethodMetadata(path, type)
    const span = this.startSpan(this.operationName(), {
      service: this.config.service || this.serviceName(),
      resource: path,
      kind: 'client',
      type: 'http',
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
    }, false)
    // needed as precursor for peer.service
    if (method.service && method.package) {
      span.setTag('rpc.service', method.package + '.' + method.service)
    }

    if (metadata) {
      addMetadataTags(span, metadata, metadataFilter, 'request')
      inject(this.tracer, span, metadata)
    }

    message.span = span
    message.parentStore = store
    message.currentStore = { ...store, span }

    return message.currentStore
  }

  bindAsyncStart ({ parentStore }) {
    return parentStore
  }

  error ({ span, error }) {
    this.addCode(span, error.code)
    this.addError(error, span)
  }

  finish ({ span, result, peer }) {
    if (!span) return

    const { code, metadata } = result || {}
    const metadataFilter = this.config.metadataFilter

    this.addCode(span, code)

    if (metadata && metadataFilter) {
      addMetadataTags(span, metadata, metadataFilter, 'response')
    }

    if (peer) {
      // The only scheme we want to support here is ipv[46]:port, although
      // more are supported by the library
      // https://github.com/grpc/grpc/blob/v1.60.0/doc/naming.md
      const parts = peer.split(':')
      if (parts[parts.length - 1].match(/^\d+/)) {
        const port = parts[parts.length - 1]
        const ip = parts.slice(0, -1).join(':')
        span.setTag('network.destination.ip', ip)
        span.setTag('network.destination.port', port)
      } else {
        span.setTag('network.destination.ip', peer)
      }
    }

    this.tagPeerService(span)
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
