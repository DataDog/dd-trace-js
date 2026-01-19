'use strict'

const dc = require('dc-polyfill')

const { entryTags } = require('../../datadog-code-origin')
const Plugin = require('../../dd-trace/src/plugins/plugin')
const web = require('../../dd-trace/src/plugins/util/web')

class ExpressCodeOriginForSpansPlugin extends Plugin {
  static id = 'express'

  constructor (...args) {
    super(...args)

    const layerTags = new WeakMap()

    // Middleware/request handling: apply pre-computed tags to spans
    const handleMiddlewareEnter = ({ req, layer }) => {
      const tags = layerTags.get(layer)
      if (!tags) return
      web.getContext(req)?.span?.addTags(tags)
    }

    this.addSub('apm:express:middleware:enter', handleMiddlewareEnter)
    this.addSub('apm:router:middleware:enter', handleMiddlewareEnter)

    // Route added handling: compute and cache tags
    const handleRouteAdded = ({ topOfStackFunc, layer }) => {
      if (!layer) return
      if (layerTags.has(layer)) return
      layerTags.set(layer, entryTags(topOfStackFunc))
    }

    if (this._tracerConfig.remoteConfig?.enabled) {
      // When RC is enabled, use manual subscriptions (always pre-compute)
      // This allows tags to be computed even when CO is disabled, so runtime enabling works
      dc.channel('apm:express:route:added').subscribe(handleRouteAdded)
      dc.channel('apm:router:route:added').subscribe(handleRouteAdded)
    } else {
      // When RC is disabled, use addSub (only computes when CO is enabled)
      this.addSub('apm:express:route:added', handleRouteAdded)
      this.addSub('apm:router:route:added', handleRouteAdded)
    }
  }
}

module.exports = ExpressCodeOriginForSpansPlugin
