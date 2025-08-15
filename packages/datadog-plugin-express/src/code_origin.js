'use strict'

const { entryTags } = require('../../datadog-code-origin')
const WebPlugin = require('../../datadog-plugin-web/src')

class ExpressCodeOriginForSpansPlugin extends WebPlugin {
  static id = 'express'

  constructor (...args) {
    super(...args)

    const layerTags = new WeakMap()

    this.addSub('apm:express:middleware:enter', ({ req, layer }) => {
      const tags = layerTags.get(layer)
      if (!tags) return
      this.getContext(req).span?.addTags(tags)
    })

    this.addSub('apm:express:route:added', ({ topOfStackFunc, layer }) => {
      if (layerTags.has(layer)) return
      layerTags.set(layer, entryTags(topOfStackFunc))
    })
  }
}

module.exports = ExpressCodeOriginForSpansPlugin
