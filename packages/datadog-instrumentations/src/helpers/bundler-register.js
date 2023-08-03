'use strict'

const dc = require('../../../diagnostics_channel')

const {
  filename,
  loadChannel,
  matchVersion
} = require('./register')
const hooks = require('./hooks')
const instrumentations = require('./instrumentations')
const log = require('../../../dd-trace/src/log')

const CHANNEL = 'dd-trace:bundler:load'

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
