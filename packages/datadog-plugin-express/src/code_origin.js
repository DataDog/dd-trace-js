'use strict'

const { entryTags } = require('../../datadog-code-origin')
const Plugin = require('../../dd-trace/src/plugins/plugin')
const web = require('../../dd-trace/src/plugins/util/web')

class ExpressCodeOriginForSpansPlugin extends Plugin {
  static id = 'express'

  constructor (...args) {
    super(...args)

    const layerTags = new WeakMap()

    this.addSub('apm:express:middleware:enter', ({ req, layer }) => {
      const tags = layerTags.get(layer)
      if (!tags) return
      web.getContext(req).span?.addTags(tags)
    })

    this.addSub('apm:express:route:added', ({ topOfStackFunc, layer }) => {
      if (layerTags.has(layer)) return
      layerTags.set(layer, entryTags(topOfStackFunc))
    })
    this.addSub('apm:router:middleware:enter', ({ req, layer }) => {
      const tags = layerTags.get(layer)
      if (!tags) return
      web.getContext(req).span?.addTags(tags)
    })

    this.addSub('apm:router:route:added', ({ topOfStackFunc, layer }) => {
      if (layerTags.has(layer)) return
      layerTags.set(layer, entryTags(topOfStackFunc))
    })
  }
}

module.exports = ExpressCodeOriginForSpansPlugin
