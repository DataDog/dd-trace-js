'use strict'

const RouterPlugin = require('../../datadog-plugin-router/src')
const { normalizeRouteSegment } = require('../../dd-trace/src/http-resource')
const web = require('../../dd-trace/src/plugins/util/web')

class RestifyPlugin extends RouterPlugin {
  static id = 'restify'

  constructor (...args) {
    super(...args)

    this.addSub('apm:restify:request:handle', ({ req }) => {
      this.setFramework(req, 'restify', this.config)
      web.setSamplingRoute(req, restifyRoute)
    })
  }

  configure (config) {
    return super.configure({
      ...config,
      middleware: false, // not supported
    })
  }
}

/**
 * @param {{ method: string, route?: { path?: string | RegExp } }} req
 */
function restifyRoute (req) {
  const path = req.route?.path
  if (typeof path === 'string') return normalizeRouteSegment(path)
}

module.exports = RestifyPlugin
