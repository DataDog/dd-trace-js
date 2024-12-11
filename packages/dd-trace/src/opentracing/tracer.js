'use strict'

const os = require('os')
const Span = require('./span')
const NoopSpan = require('../noop/span')
const SpanProcessor = require('../span_processor')
const PrioritySampler = require('../priority_sampler')
const TextMapPropagator = require('./propagation/text_map')
const DSMTextMapPropagator = require('./propagation/text_map_dsm')
const HttpPropagator = require('./propagation/http')
const BinaryPropagator = require('./propagation/binary')
const LogPropagator = require('./propagation/log')
const formats = require('../../../../ext/formats')

const log = require('../log')
const runtimeMetrics = require('../runtime_metrics')
const getExporter = require('../exporter')
const SpanContext = require('./span_context')

const REFERENCE_CHILD_OF = 'child_of'
const REFERENCE_FOLLOWS_FROM = 'follows_from'

class DatadogTracer {
  constructor (config, prioritySampler) {
    const Exporter = getExporter(config.experimental.exporter)

    this._config = config
    this._service = config.service
    this._version = config.version
    this._env = config.env
    this._logInjection = config.logInjection
    this._debug = config.debug
    this._prioritySampler = prioritySampler ?? new PrioritySampler(config.env, config.sampler)
    this._exporter = new Exporter(config, this._prioritySampler)
    this._processor = new SpanProcessor(this._exporter, this._prioritySampler, config)
    this._url = this._exporter._url
    this._enableGetRumData = config.experimental.enableGetRumData
    this._traceId128BitGenerationEnabled = config.traceId128BitGenerationEnabled
    this._propagators = {
      [formats.TEXT_MAP]: new TextMapPropagator(config),
      [formats.HTTP_HEADERS]: new HttpPropagator(config),
      [formats.BINARY]: new BinaryPropagator(config),
      [formats.LOG]: new LogPropagator(config),
      [formats.TEXT_MAP_DSM]: new DSMTextMapPropagator(config)
    }
    if (config.reportHostname) {
      this._hostname = os.hostname()
    }
  }

  startSpan (name, options = {}) {
    const updateParentSpan = (ctx, span, options, name) => {
      let tags
      if (span) {
        tags = span?.context()._tags ?? {}
      } else if (ctx) {
        tags = ctx?._tags ?? {}
      } else {
        return
      }

      // Find the highest index in operations keys
      const keys = Object.keys(tags).filter(key => key.startsWith('operations.'))
      const indices = keys.map(key => parseInt(key.split('.')[1], 10)) // Extract the index from the keys
      const nextIndex = new Set(indices).size

      // Update operations object with new tags using dot notation
      span.setTag(`operations.${nextIndex}.name`, name)

      // Loop through options to add sub tags under the new index
      Object.entries(options).forEach(([key, value]) => {
        if (key !== 'childOf' && key !== 'tags') {
          span.setTag(`operations.${nextIndex}.${key}`, value)
        }
      })

      if (options.tags) {
        // Loop through options to add sub tags under the new index
        Object.entries(options.tags).forEach(([key, value]) => {
          if (key !== 'childOf') {
            span.setTag(`operations.${nextIndex}.tags.${key}`, value)
          }
        })
      }
      return nextIndex
    }

    const parent = options.childOf
      ? getContext(options.childOf)
      : getParent(options.references)

    // as per spec, allow the setting of service name through options
    const tags = {
      'service.name': options?.tags?.service ? String(options.tags.service) : this._service
    }

    // zero trace level indicates service exit / entry span only
    if (this._config.traceLevel === 0) {
      // if the parent is a SpanContext, this is a distributed trace and should create a child span
      // if the parent is a Span or NoopSpan, this is from the same service
      if (
        parent instanceof Span || parent instanceof NoopSpan ||
        options.childOf instanceof Span || options.childOf instanceof NoopSpan
      ) {
        let metaIndex = 0
        // if (parent instanceof Span) {
        //   metaIndex = updateParentSpan(null, options.childOf, options, name)
        // } else if (parent instanceof SpanContext) {
        //   metaIndex = updateParentSpan(null, options.childOf, options, name)
        // }
        return new NoopSpan(this, parent, { keepParent: true, metaIndex })
      }
    } else if (this._config.traceLevel === 1) {
      if (parent) {
        if (
          options?.tags && parent._tags && options?.tags['span.kind'] &&
          parent._tags['span.kind'] === options.tags['span.kind']
        ) {
          let metaIndex = 0
          // if (parent instanceof Span) {
          //   metaIndex = updateParentSpan(null, options.childOf, options, name)
          // } else if (parent instanceof SpanContext) {
          //   metaIndex = updateParentSpan(null, options.childOf, options, name)
          // }
          return new NoopSpan(this, parent, { keepParent: true, metaIndex })
        }
      }
    } else if (this._config.traceLevel === 2) {
      if (parent) {
        if (options?.tags?.component && parent?._tags?.component === options?.tags?.component) {
          let metaIndex = 0
          // if (parent instanceof Span) {
          //   metaIndex = updateParentSpan(null, options.childOf, options, name)
          // } else if (parent instanceof SpanContext) {
          //   metaIndex = updateParentSpan(null, options.childOf, options, name)
          // }
          return new NoopSpan(this, parent, { keepParent: true, metaIndex })
        }
      }
    }

    // As per unified service tagging spec if a span is created with a service name different from the global
    // service name it will not inherit the global version value
    if (options?.tags?.service && options.tags.service !== this._service) {
      options.tags.version = undefined
    }

    const span = new Span(this, this._processor, this._prioritySampler, {
      operationName: options.operationName || name,
      parent,
      tags,
      startTime: options.startTime,
      hostname: this._hostname,
      traceId128BitGenerationEnabled: this._traceId128BitGenerationEnabled,
      integrationName: options.integrationName,
      links: options.links
    }, this._debug)

    span.addTags(this._config.tags)
    span.addTags(options.tags)

    return span
  }

  inject (context, format, carrier) {
    if (context instanceof Span || context instanceof NoopSpan) {
      context = context.context()
    }

    try {
      if (format !== 'text_map_dsm') {
        this._prioritySampler.sample(context)
      }
      this._propagators[format].inject(context, carrier)
    } catch (e) {
      log.error(e)
      runtimeMetrics.increment('datadog.tracer.node.inject.errors', true)
    }
  }

  extract (format, carrier) {
    try {
      return this._propagators[format].extract(carrier)
    } catch (e) {
      log.error(e)
      runtimeMetrics.increment('datadog.tracer.node.extract.errors', true)
      return null
    }
  }
}

function getContext (spanContext) {
  if (spanContext instanceof Span) {
    spanContext = spanContext.context()
  }

  if (spanContext instanceof NoopSpan) {
    spanContext = spanContext.context()
  }

  if (!(spanContext instanceof SpanContext)) {
    spanContext = null
  }

  return spanContext
}

function getParent (references = []) {
  let parent = null

  for (let i = 0; i < references.length; i++) {
    const ref = references[i]
    const type = ref.type()

    if (type === REFERENCE_CHILD_OF) {
      parent = ref.referencedContext()
      break
    } else if (type === REFERENCE_FOLLOWS_FROM) {
      if (!parent) {
        parent = ref.referencedContext()
      }
    }
  }

  return parent
}

module.exports = DatadogTracer
