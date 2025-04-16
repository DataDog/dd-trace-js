'use strict'

const { entryTags } = require('../../datadog-code-origin')
const Plugin = require('../../dd-trace/src/plugins/plugin')
const web = require('../../dd-trace/src/plugins/util/web')

const kCodeOriginForSpansTagsSym = Symbol('datadog.codeOriginForSpansTags')

class ExpressCodeOriginForSpansPlugin extends Plugin {
  static get id () {
    return 'express'
  }

  constructor (...args) {
    super(...args)

    this.addSub('apm:express:middleware:enter', ({ req, layer }) => {
      const tags = layer[kCodeOriginForSpansTagsSym]
      if (!tags) return
      const context = web.getContext(req)
      context.span?.addTags(tags)
    })

    this.addSub('apm:express:route:added', ({ topOfStackFunc, layer }) => {
      if (Object.hasOwn(layer, kCodeOriginForSpansTagsSym)) return

      layer[kCodeOriginForSpansTagsSym] = entryTags(topOfStackFunc, 1)
    })
  }
}

module.exports = ExpressCodeOriginForSpansPlugin
