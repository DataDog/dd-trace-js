'use strict'

const { USER_ID } = require('../addresses')
const Gateway = require('../gateway/engine')
const { getRootSpan } = require('./utils')
const { block } = require('../blocking')
const { storage } = require('../../../../datadog-core')
const { setUserTags } = require('./set_user')
const log = require('../../log')

function isUserBlocked (user) {
  const results = Gateway.propagate({ [USER_ID]: user.id })

  if (!results) {
    return false
  }

  for (const entry of results) {
    if (entry && entry.includes('block')) {
      return true
    }
  }

  return false
}

function checkUserAndSetUser (tracer, user) {
  if (!user || !user.id) {
    log.warn('Invalid user provided to isUserBlocked')
    return false
  }

  const rootSpan = getRootSpan(tracer)
  if (rootSpan) {
    if (!rootSpan.context()._tags['usr.id']) {
      setUserTags(user, rootSpan)
    }
  } else {
    log.warn('Root span not available in isUserBlocked')
  }

  return isUserBlocked(user)
}

function blockRequest (tracer, req, res) {
  if (!req || !res) {
    const store = storage.getStore()
    if (store) {
      req = req || store.req
      res = res || store.res
    }
  }

  if (!req || !res) {
    log.warn('Requests or response object not available in blockRequest')
    return false
  }

  const rootSpan = getRootSpan(tracer)
  if (!rootSpan) {
    log.warn('Root span not available in blockRequest')
    return false
  }

  block(req, res, rootSpan)

  return true
}

module.exports = {
  checkUserAndSetUser,
  blockRequest
}
