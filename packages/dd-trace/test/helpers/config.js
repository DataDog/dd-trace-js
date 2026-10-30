'use strict'

const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

const proxyquire = require('proxyquire')

function getConfigFresh (options, stubs = {}) {
  const childCountBefore = module.children.length
  const loadHelper = proxyquire.noPreserveCache()
  const helper = loadHelper('../../src/config/helper.js', {})
  const loadDefaults = proxyquire.noPreserveCache()
  const defaults = loadDefaults('../../src/config/defaults.js', {})
  const loadConfig = proxyquire.noPreserveCache()
  const createConfig = loadConfig('../../src/config', {
    './defaults': defaults,
    './helper': helper,
    ...stubs,
  })
  const config = createConfig(options)
  // proxyquire links every freshly loaded module into this module's `children`;
  // `noPreserveCache` clears `require.cache` but not that array, so each
  // re-instrumented config graph stays pinned for the process lifetime. Detaching
  // them lets the fresh graph collect once the returned config is dropped.
  module.children.length = childCountBefore
  return config
}

const fixture = join(__dirname, '../fixtures/otel-startup.js')

/**
 * @param {Record<string, string | undefined>} [env]
 * @param {Record<string, unknown>} [options]
 */
function runStartup (env = {}, options = {}) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(DD_|_DD_|OTEL_)/.test(name)))
  const stdout = execFileSync(process.execPath, [fixture, JSON.stringify(options)], {
    env: { ...inherited, ...env },
    encoding: 'utf8',
    timeout: 15000,
  })
  return JSON.parse(stdout.slice(stdout.lastIndexOf('STARTUP_RESULT ') + 'STARTUP_RESULT '.length))
}

module.exports = {
  fixture,
  runStartup,
  getConfigFresh,
}
