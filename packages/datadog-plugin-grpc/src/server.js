'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const Tags = require('../../../ext/tags')
const { TEXT_MAP } = require('../../../ext/formats')
const { addMethodTags, addMetadataTags, getFilter } = require('./util')

class GrpcServerPlugin extends Plugin {
  static get name () {
    return 'http'
  }

  constructor (...args) {
    super(...args)

    this.addSub('apm:grpc:server:request:start', ({ name, metadata, type }) => {
      const metadataFilter = this.config.metadataFilter
      const store = storage.getStore()
      const childOf = extract(this.tracer, metadata)
      const span = this.tracer.startSpan('grpc.request', {
        childOf,
        tags: {
          [Tags.SPAN_KIND]: 'server',
          'span.type': 'web',
          'resource.name': name,
          'service.name': this.config.service || `${this.tracer._service}`,
          'component': 'grpc'
        }
      })

      addMethodTags(span, name, type)
      addMetadataTags(span, metadata, metadataFilter, 'request')

      analyticsSampler.sample(span, this.config.measured, true)

      this.enter(span, store)
    })

    this.addSub('apm:grpc:server:request:error', error => {
      const store = storage.getStore()

      if (!store || !store.span) return

      this.addCode(store.span, error.code)
      this.addError(error)
    })

    this.addSub('apm:grpc:server:request:update', ({ code }) => {
      const store = storage.getStore()

      if (!store || !store.span) return

      this.addCode(store.span, code)
    })

    this.addSub('apm:grpc:server:request:finish', ({ code, trailer } = {}) => {
      const store = storage.getStore()

      if (!store || !store.span) return

      const span = store.span
      const metadataFilter = this.config.metadataFilter

      this.addCode(span, code)

      if (trailer && metadataFilter) {
        addMetadataTags(span, trailer, metadataFilter, 'response')
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

function extract (tracer, metadata) {
  if (!metadata || typeof metadata.getMap !== 'function') return null

  return tracer.extract(TEXT_MAP, metadata.getMap())
}

module.exports = GrpcServerPlugin
