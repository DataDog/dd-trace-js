'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')
const tags = require('../../../ext/tags')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const formats = require('../../../ext/formats')
const HTTP_HEADERS = formats.HTTP_HEADERS
const urlFilter = require('../../dd-trace/src/plugins/util/urlfilter')
const log = require('../../dd-trace/src/log')
const url = require('url')

const HTTP_STATUS_CODE = tags.HTTP_STATUS_CODE
const HTTP_REQUEST_HEADERS = tags.HTTP_REQUEST_HEADERS
const HTTP_RESPONSE_HEADERS = tags.HTTP_RESPONSE_HEADERS

class HttpClientPlugin extends Plugin {
  static get name () {
    return 'http'
  }

  constructor (...args) {
    super(...args)

    this.addSub('apm:http:client:request:start', ({ args, http }) => {
      const store = storage.getStore()
      const options = args.options
      const agent = options.agent || options._defaultAgent || http.globalAgent
      const protocol = options.protocol || agent.protocol || 'http:'
      const hostname = options.hostname || options.host || 'localhost'
      const host = options.port ? `${hostname}:${options.port}` : hostname
      const path = options.path ? options.path.split(/[?#]/)[0] : '/'
      const uri = `${protocol}//${host}${path}`

      const method = (options.method || 'GET').toUpperCase()
      const childOf = store ? store.span : store
      const span = this.tracer.startSpan('http.request', {
        childOf,
        tags: {
          'span.kind': 'client',
          'service.name': getServiceName(this.tracer, this.config, options),
          'resource.name': method,
          'span.type': 'http',
          'http.method': method,
          'http.url': uri
        }
      })

      if (!(hasAmazonSignature(options) || !this.config.propagationFilter(uri))) {
        this.tracer.inject(span, HTTP_HEADERS, options.headers)
      }

      analyticsSampler.sample(span, this.config.measured)
      this.enter(span, store)
    })

    this.addSub('apm:fetch:start', ({ req }) => {
      const store = storage.getStore()
      const childOf = store ? store.span : store
      const method = req.method
      const uri = new URL(req.url)
      uri.hash = ''
      uri.search = ''
      const span = this.tracer.startSpan('http.request', {
        childOf,
        tags: {
          'span.kind': 'client',
          'service.name': getServiceName(this.tracer, this.config, req),
          'resource.name': method,
          'span.type': 'http',
          'http.method': method,
          'http.url': uri.toString()
        }
      })
      span.request = req

      if (!(hasAmazonSignatureFetch(req) || !this.config.propagationFilter(uri))) {
        const injected = {}
        this.tracer.inject(span, HTTP_HEADERS, injected)
        for (const key in injected) {
          req.headers.append(key, injected[key])
        }
      }

      analyticsSampler.sample(span, this.config.measured)
      this.enter(span, store)
    })

    this.addSub('apm:http:client:request:end', this.exit.bind(this))

    this.addSub('apm:fetch:end', ({ response }) => {
      const store = storage.getStore()
      response.then(r => {
        store.response = r
      })
      this.exit()
    })

    this.addSub('apm:http:client:request:async-end', ({ req, res }) => {
      const span = storage.getStore().span
      if (res) {
        span.setTag(HTTP_STATUS_CODE, res.statusCode)

        if (!this.config.validateStatus(res.statusCode)) {
          span.setTag('error', 1)
        }

        addResponseHeaders(res, span, this.config)
      } else {
        span.setTag('error', 1)
      }

      addRequestHeaders(req, span, this.config)

      this.config.hooks.request(span, req, res)
      span.finish()
    })

    this.addSub('apm:fetch:async-end', () => {
      const { span, response } = storage.getStore()
      const request = span.request
      if (span && request, response) {
        span.setTag(HTTP_STATUS_CODE, response.status)

        if (!this.config.validateStatus(response.status)) {
          span.setTag('error', 1)
        }

        addResponseHeaders(response, span, this.config)
      } else {
        span.setTag('error', 1)
      }

      addRequestHeaders(request, span, this.config)

      this.config.hooks.request(span, request, response)
      span.finish()
    })

    this.addSub('apm:http:client:request:error', errorHandler)
  }

  configure (config) {
    return super.configure(normalizeClientConfig(config))
  }
}

function errorHandler (err) {
  const span = storage.getStore().span
  span.addTags({
    'error.type': err.name,
    'error.msg': err.message,
    'error.stack': err.stack
  })
}

function addResponseHeaders (res, span, config) {
  config.headers.forEach(key => {
    const value = res.headers[key]

    if (value) {
      span.setTag(`${HTTP_RESPONSE_HEADERS}.${key}`, value)
    }
  })
}

function addRequestHeaders (req, span, config) {
  config.headers.forEach(key => {
    const value = req.getHeader(key)

    if (value) {
      span.setTag(`${HTTP_REQUEST_HEADERS}.${key}`, value)
    }
  })
}

function addResponseHeadersFetch (res, span, config) {
  config.headers.forEach(key => {
    const value = res.headers.get(key)

    if (value) {
      span.setTag(`${HTTP_RESPONSE_HEADERS}.${key}`, value)
    }
  })
}

function addRequestHeadersFetch (req, span, config) {
  config.headers.forEach(key => {
    const value = req.headers.get(key)

    if (value) {
      span.setTag(`${HTTP_REQUEST_HEADERS}.${key}`, value)
    }
  })
}

function normalizeClientConfig (config) {
  const validateStatus = getStatusValidator(config)
  const propagationFilter = getFilter({ blocklist: config.propagationBlocklist })
  const headers = getHeaders(config)
  const hooks = getHooks(config)

  return Object.assign({}, config, {
    validateStatus,
    propagationFilter,
    headers,
    hooks
  })
}

function getStatusValidator (config) {
  if (typeof config.validateStatus === 'function') {
    return config.validateStatus
  } else if (config.hasOwnProperty('validateStatus')) {
    log.error('Expected `validateStatus` to be a function.')
  }
  return code => code < 400 || code >= 500
}

function getFilter (config) {
  config = Object.assign({}, config, {
    blocklist: config.blocklist || []
  })

  return urlFilter.getFilter(config)
}

function getHeaders (config) {
  if (!Array.isArray(config.headers)) return []

  return config.headers
    .filter(key => typeof key === 'string')
    .map(key => key.toLowerCase())
}

function getHooks (config) {
  const noop = () => {}
  const request = (config.hooks && config.hooks.request) || noop

  return { request }
}

function hasAmazonSignature (options) {
  if (!options) {
    return false
  }

  if (options.headers) {
    const headers = Object.keys(options.headers)
      .reduce((prev, next) => Object.assign(prev, {
        [next.toLowerCase()]: options.headers[next]
      }), {})

    if (headers['x-amz-signature']) {
      return true
    }

    if ([].concat(headers['authorization']).some(startsWith('AWS4-HMAC-SHA256'))) {
      return true
    }
  }

  return options.path && options.path.toLowerCase().indexOf('x-amz-signature=') !== -1
}

function hasAmazonSignatureFetch (req) {
  if (!req) {
    return false
  }

  if (req.headers) {
    if (req.headers.has('x-amz-signature')) {
      return true
    }

    const auth = req.headers.get('authorization')
    if (auth && auth.split(',').map(x => x.trimStart()).some(startsWith('AWS4-HMAC-SHA256'))) {
      return true
    }
  }

  const uri = url.parse(req.url)
  return uri.path && uri.path.toLowerCase().indexOf('x-amz-signature=') !== -1
}

function getServiceName (tracer, config, options) {
  if (config.splitByDomain) {
    return getHost(options)
  } else if (config.service) {
    return config.service
  }

  return `${tracer._service}-http-client`
}

function getHost (options) {
  if (typeof options === 'string') {
    return url.parse(options).host
  }
  if (globalThis.Request && options instanceof globalThis.Request) {
    return url.parse(options.url).host
  }

  const hostname = options.hostname || options.host || 'localhost'
  const port = options.port

  return [hostname, port].filter(val => val).join(':')
}

function startsWith (searchString) {
  return value => String(value).startsWith(searchString)
}

module.exports = HttpClientPlugin
