'use strict'

const log = require('../../log')
const web = require('../../plugins/util/web')
const addresses = require('../addresses')
const { handleResults } = require('../blocking')
const { getActiveRequest } = require('../store')
const UserTracking = require('../user_tracking')
const waf = require('../waf')

function onPassportVerify ({ framework, login, user, success, abortController }) {
  const req = getActiveRequest()
  const rootSpan = req && web.root(req)

  if (!rootSpan) {
    log.warn('[ASM] No rootSpan found in onPassportVerify')
    return
  }

  const results = UserTracking.trackLogin(framework, login, user, success, rootSpan)

  handleResults(results?.actions, req, web.getContext(req)?.res, rootSpan, abortController)
}

function onPassportDeserializeUser ({ user, abortController }) {
  const req = getActiveRequest()
  const rootSpan = req && web.root(req)

  if (!rootSpan) {
    log.warn('[ASM] No rootSpan found in onPassportDeserializeUser')
    return
  }

  const results = UserTracking.trackUser(user, rootSpan)

  handleResults(results?.actions, req, web.getContext(req)?.res, rootSpan, abortController)
}

function onExpressSession ({ req, res, sessionId, abortController }) {
  const rootSpan = web.root(req)
  if (!rootSpan) {
    log.warn('[ASM] No rootSpan found in onExpressSession')
    return
  }

  const isSdkCalled = rootSpan.context().getTag('usr.session_id')
  if (isSdkCalled) return

  const results = waf.run({
    persistent: {
      [addresses.USER_SESSION_ID]: sessionId,
    },
  }, req)

  handleResults(results?.actions, req, res, rootSpan, abortController)
}

module.exports = {
  onPassportVerify,
  onPassportDeserializeUser,
  onExpressSession,
}
