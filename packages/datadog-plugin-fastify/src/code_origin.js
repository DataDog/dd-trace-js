'use strict'

const dc = require('dc-polyfill')

const { entryTags } = require('../../datadog-code-origin')
const Plugin = require('../../dd-trace/src/plugins/plugin')
const web = require('../../dd-trace/src/plugins/util/web')

const kCodeOriginForSpansTagsSym = Symbol('datadog.codeOriginForSpansTags')

class FastifyCodeOriginForSpansPlugin extends Plugin {
  static id = 'fastify'

  constructor (...args) {
    super(...args)

    this.addSub('apm:fastify:request:handle', ({ req, routeConfig }) => {
      const tags = routeConfig?.[kCodeOriginForSpansTagsSym]
      if (!tags) return
      web.getContext(req)?.span?.addTags(tags)
    })

    if (this._tracerConfig.remoteConfig?.enabled) {
      // When RC is enabled, use manual subscription (always pre-computes)
      // This allows tags to be computed even when CO is disabled, so runtime enabling works
      dc.channel('apm:fastify:route:added').subscribe(handleRouteAdded)
    } else {
      // When RC is disabled, use addSub (only computes when CO is enabled)
      this.addSub('apm:fastify:route:added', handleRouteAdded)
    }
  }
}

module.exports = FastifyCodeOriginForSpansPlugin

// Route added handling: compute and cache tags
function handleRouteAdded ({ routeOptions, onRoute }) {
  if (!routeOptions.config) routeOptions.config = {}
  if (routeOptions.config[kCodeOriginForSpansTagsSym]) return
  routeOptions.config[kCodeOriginForSpansTagsSym] = entryTags(onRoute)
}
