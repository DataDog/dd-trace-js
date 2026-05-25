'use strict'

const path = require('node:path')
const { sandboxCwd } = require('./index')

/**
 * Registers before/after hooks that launch a shared Playwright browser server
 * for the enclosing describe block, so each exec'd `playwright test` subprocess
 * connects to an existing browser instead of launching a new one.
 *
 * Must be called after the before() hook that installs Chromium, so that
 * playwright-core and the browser binary are ready.
 *
 * The endpoint is written to process.env.BROWSER_WS_ENDPOINT, which is picked
 * up automatically by getCiVisAgentlessConfig/getCiVisEvpProxyConfig (both
 * spread process.env) and read by integration-tests/playwright.config.js.
 */
function useBrowserServer () {
  let browserServer

  before(async function () {
    const { chromium } = require(path.join(sandboxCwd(), 'node_modules', 'playwright-core'))
    browserServer = await chromium.launchServer()
    process.env.BROWSER_WS_ENDPOINT = browserServer.wsEndpoint()
  })

  after(async function () {
    await browserServer?.close()
    delete process.env.BROWSER_WS_ENDPOINT
  })
}

module.exports = { useBrowserServer }
