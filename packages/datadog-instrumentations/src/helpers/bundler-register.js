'use strict'

const dc = require('dc-polyfill')

const {
  filename,
  loadChannel,
  matchVersion
} = require('./register.js')
const hooks = require('./hooks')
const instrumentations = require('./instrumentations')
const log = require('../../../dd-trace/src/log')

const CHANNEL = 'dd-trace:bundler:load'

if (!dc.subscribe) {
  dc.subscribe = (channel, cb) => {
    dc.channel(channel).subscribe(cb)
  }
}
if (!dc.unsubscribe) {
  dc.unsubscribe = (channel, cb) => {
    if (dc.channel(channel).hasSubscribers) {
      dc.channel(channel).unsubscribe(cb)
    }
  }
}

dc.subscribe(CHANNEL, (payload) => {
  try {
    hooks[payload.package]()
  } catch (err) {
    log.error(`esbuild-wrapped ${payload.package} missing in list of hooks`)
    throw err
  }

  if (!instrumentations[payload.package]) {
    log.error(`esbuild-wrapped ${payload.package} missing in list of instrumentations`)
    return
  }

  for (const { name, file, versions, hook } of instrumentations[payload.package]) {
    if (payload.path !== filename(name, file)) continue
    if (!matchVersion(payload.version, versions)) continue

    try {
      loadChannel.publish({ name, version: payload.version, file })
      payload.module = hook(payload.module, payload.version)
    } catch (e) {
      log.error(e)
    }
  }
})
