'use strict'

const { storage } = require('../../../../datadog-core')
const addresses = require('../addresses')
const { httpClientRequestStart } = require('../channels')
const waf = require('../waf')

function enable () {
  httpClientRequestStart.subscribe(analyzeSsrf)
}

function disable () {
  httpClientRequestStart.unsubscribe(analyzeSsrf)
}

function getOutgoingUrl (args) {
  if (args) {
    if (args.uri) {
      return args.uri
    }
    if (args.options) {
      if (args.options.href) {
        return args.options.href
      }
      if (args.options.protocol && args.options.hostname) {
        let url = `${args.options.protocol}//${args.options.hostname}`
        if (args.options.port) {
          url += `:${args.options.port}`
        }
        url += args.options.path || ''
        return url
      }
    }
  }
}

function analyzeSsrf (ctx) {
  const store = storage.getStore()
  const req = store?.req
  if (req) {
    const url = getOutgoingUrl(ctx.args)
    if (url) {
      const persistent = {
        [addresses.RASP_IO_URL]: url
      }
      // TODO: Currently this is only monitoring, we should
      //     block the request if SSRF attempt and
      //     generate stack traces
      waf.run({ persistent }, req)
    }
  }
}

module.exports = {
  enable,
  disable
}
