'use strict'

const addresses = require('../addresses')
const Gateway = require('../gateway/engine')
const { getRootSpan } = require('./utils')
const { block } = require('../blocking')
const { storage } = require('../../../../datadog-core')
const { setUserTags } = require('./set_user')
const log = require('../../log')

function isUserBlocked (user) {
  const results = Gateway.propagate({ [addresses.USER_ID]: user.id })

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
    return false
  }

  const rootSpan = getRootSpan(tracer)
  if (!rootSpan) {
    log.warn('Root span not available, checkUserAndSetUser failed')
    return false
  }

  const userId = rootSpan.context()._tags['usr.id']
  if (!userId) {
    setUserTags(user, rootSpan)
  }
  return isUserBlocked(user)
}

function blockRequest (tracer, req, res) {
  let request, response
  if (!req || !res) {
    const store = storage.getStore()
    request = req || (store && store.req)
    response = res || (store && store.res)
  } else {
    request = req
    response = res
  }

  if (!request || !response) {
    log.warn('Requests or response object not available, blockRequest failed')
    return false
  }

  const topSpan = getRootSpan(tracer)
  if (!topSpan) {
    log.warn('Root span not available, blockRequest failed')
    return false
  }

  block({
    req: request,
    res: response,
    topSpan: topSpan
  })
  return true
}

module.exports = {
  checkUserAndSetUser,
  blockRequest
}
