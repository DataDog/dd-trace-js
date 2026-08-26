'use strict'

const assert = require('node:assert/strict')

const guard = require('../startup-guard')
const clearTimeoutGuard = require('../timeout-guard')('appsec-iast server')
const tracer = require('../../..')

const express = require('../../../versions/express').get()
const cookieParser = require('../../../versions/cookie-parser').get()
const { port, reqs, warmup } = require('./common')

/**
 * @param {(request: import('express').Request) => void} [onRequest]
 * @param {string} [expectedVulnerability]
 */
module.exports = function startServer (onRequest, expectedVulnerability) {
  let featureValidated = false
  let acquiredRequests = 0
  let hookCalls = 0
  let lastIastEnabled
  let vulnerabilityReported = false

  tracer.use('express', {
    hooks: {
      /** @param {import('../../../index').Span} span */
      request (span) {
        const context = span.context()
        hookCalls++
        lastIastEnabled = context.getTag('_dd.iast.enabled')
        if (lastIastEnabled !== 1) return

        acquiredRequests++
        if (expectedVulnerability) {
          const iastJson = context.getTag('_dd.iast.json')
          vulnerabilityReported = iastJson?.includes(`"type":"${expectedVulnerability}"`) === true
          if (!vulnerabilityReported) return
        }

        featureValidated = true
        tracer.use('express', {})
      },
    },
  })

  const app = express()
  app.use(cookieParser())

  let responsesFinished = 0

  function onResponseFinish () {
    responsesFinished++
    if (responsesFinished === warmup) {
      assert.ok(
        featureValidated,
        `IAST preflight failed (hooks: ${hookCalls}, acquired: ${acquiredRequests}, ` +
          `last enabled: ${lastIastEnabled}, vulnerability: ${vulnerabilityReported})`
      )
      guard.loopStart()
    } else if (responsesFinished === reqs + warmup) {
      guard.done(0.1)
      server.close()
    }
  }

  /**
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   */
  function handleRequest (req, res) {
    res.once('finish', onResponseFinish)
    onRequest?.(req)

    res.writeHead(200)
    res.end('Hello, World!')
  }

  app.get('/', handleRequest)

  const server = app.listen(port, () => {
    assert.ok(server.address(), 'appsec-iast server failed to bind')
  })
  server.once('close', clearTimeoutGuard)
}
