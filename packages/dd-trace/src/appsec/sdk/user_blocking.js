'use strict'

const { USER_ID } = require('../addresses')
const waf = require('../waf')
const { block, getBlockingAction } = require('../blocking')
const log = require('../../log')
const web = require('../../plugins/util/web')
const { getActiveRequest } = require('../store')
const { setUserTags } = require('./set_user')
const { getRootSpan } = require('./utils')

function isUserBlocked (user) {
  const results = waf.run({ persistent: { [USER_ID]: user.id } })
  return !!getBlockingAction(results?.actions)
}

function checkUserAndSetUser (tracer, user) {
  if (!user || !user.id) {
    log.warn('[ASM] Invalid user provided to isUserBlocked')
    return false
  }

  const rootSpan = getRootSpan()
  if (rootSpan) {
    if (!rootSpan.context().getTag('usr.id')) {
      setUserTags(user, rootSpan)
    }
  } else {
    log.warn('[ASM] Root span not available in isUserBlocked')
  }

  return isUserBlocked(user)
}

function blockRequest (tracer, req, res) {
  req ||= getActiveRequest()
  res ||= req && web.getContext(req)?.res

  if (!req || !res) {
    log.warn('[ASM] Requests or response object not available in blockRequest')
    return false
  }

  const rootSpan = getRootSpan()
  if (!rootSpan) {
    log.warn('[ASM] Root span not available in blockRequest')
    return false
  }

  return block(req, res, rootSpan)
}

module.exports = {
  checkUserAndSetUser,
  blockRequest,
}
