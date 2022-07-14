'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const Tags = require('../../../ext/tags')
const { TEXT_MAP } = require('../../../ext/formats')
const { addMethodTags, addMetadataTags, getFilter } = require('./util')

class GrpcClientPlugin extends Plugin {
  static get name () {
    return 'grpc'
  }

  constructor (...args) {
    super(...args)

    this.addSub('apm:grpc:client:request:start', ({ metadata, path, type }) => {
      const metadataFilter = this.config.metadataFilter
      const store = storage.getStore()
      const childOf = store && store.span
      const span = this.tracer.startSpan('grpc.request', {
        childOf,
        tags: {
          [Tags.SPAN_KIND]: 'client',
          'span.type': 'http',
          'resource.name': path,
          'service.name': this.config.service || `${this.tracer._service}-grpc-client`,
          'component': 'grpc'
        }
      })

      addMethodTags(span, path, type)

      if (metadata) {
        addMetadataTags(span, metadata, metadataFilter, 'request')
        inject(this.tracer, span, metadata)
      }

      analyticsSampler.sample(span, this.config.measured)

      this.enter(span, store)
    })

    this.addSub('apm:grpc:client:request:error', error => {
      const store = storage.getStore()

      if (!store || !store.span) return

      this.addCode(store.span, error.code)
      this.addError(error)
    })

    this.addSub('apm:grpc:client:request:finish', ({ code, metadata }) => {
      const store = storage.getStore()

      if (!store || !store.span) return

      const span = store.span
      const metadataFilter = this.config.metadataFilter

      this.addCode(span, code)

      if (metadata && metadataFilter) {
        addMetadataTags(span, metadata, metadataFilter, 'response')
      }

      store.span.finish()
    })
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
