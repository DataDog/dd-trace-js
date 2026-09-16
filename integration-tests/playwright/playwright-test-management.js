'use strict'

const satisfies = require('semifies')

const { createWebAppServer } = require('../ci-visibility/web-app-server')
const {
  createParallelIt,
  installPlaywrightChromium,
  sandboxCwd,
  useSandbox,
} = require('../helpers')
const { getLatestPlaywrightSpecifier, oldest } = require('./versions')

const { PLAYWRIGHT_VERSION } = process.env

const PLAYWRIGHT_TEST_MANAGEMENT_GATHER_TIMEOUT = 60000

const latest = getLatestPlaywrightSpecifier()
const versions = [oldest, latest]

/**
 * @param {(options: {
 *   contextNewVersions: Mocha.SuiteFunction | Mocha.PendingSuiteFunction,
 *   it: ReturnType<typeof createParallelIt>,
 *   latest: string,
 *   runtime: { cwd?: string, webAppPort?: number },
 *   version: string
 * }) => void} registerTests
 */
function describePlaywrightTestManagement (registerTests) {
  versions.forEach((version) => {
    if (PLAYWRIGHT_VERSION === 'oldest' && version !== oldest) return
    if (PLAYWRIGHT_VERSION === 'latest' && version !== latest) return

    // TODO: Remove this once we drop support for v5
    const contextNewVersions = satisfies(version, '>=1.38.0') || version === 'latest' ? context : context.skip

    describe(`playwright@${version}`, function () {
      const it = createParallelIt(global.it, { concurrency: 4, withReceiver: true })
      const runtime = {}
      let webAppServer

      this.timeout(120000)

      useSandbox([`@playwright/test@${version}`, '@types/node', 'typescript'], true)

      before(function (done) {
        // Increase timeout for this hook specifically to account for slow chromium installation in CI
        this.timeout(120000)

        runtime.cwd = sandboxCwd()
        installPlaywrightChromium(runtime.cwd)

        // Create fresh server instance to avoid issues with retries
        webAppServer = createWebAppServer()

        webAppServer.listen(0, (err) => {
          if (err) {
            return done(err)
          }
          runtime.webAppPort = webAppServer.address().port
          done()
        })
      })

      after(async () => {
        await new Promise(resolve => webAppServer.close(resolve))
      })

      registerTests({ contextNewVersions, it, latest, runtime, version })
    })
  })
}

module.exports = {
  PLAYWRIGHT_TEST_MANAGEMENT_GATHER_TIMEOUT,
  describePlaywrightTestManagement,
}
