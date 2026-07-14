'use strict'

const { existsSync, mkdirSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const OWNERSHIP_FILE = '.dd-c8-coverage'

const coverageDir = process.env.NODE_V8_COVERAGE
if (coverageDir && existsSync(path.join(coverageDir, OWNERSHIP_FILE))) {
  const preloadList = require('node-preload')

  if (!preloadList.includes(__filename)) preloadList.push(__filename)
  warmSourceMaps()
}

/**
 * @param {string} coverageDir
 */
function markCoverageDirectory (coverageDir) {
  mkdirSync(coverageDir, { recursive: true })
  writeFileSync(path.join(coverageDir, OWNERSHIP_FILE), '')
}

function warmSourceMaps () {
  const inspector = require('node:inspector')
  const { findSourceMap } = require('node:module')
  const { debuglog } = require('node:util')

  // Avoid resolving the whole source-map cache during coverage teardown.
  // https://github.com/nodejs/node/issues/49344
  const debug = debuglog('dd-trace:coverage')
  const pendingUrls = new Set()
  const session = new inspector.Session()
  let warmingScheduled = false

  /**
   * @param {{ params: { url: string } }} message
   */
  function onScriptParsed ({ params: { url } }) {
    if (!url.startsWith('file:')) return

    pendingUrls.add(url)
    if (!warmingScheduled) {
      warmingScheduled = true
      setImmediate(warmPendingSourceMaps)
    }
  }

  function warmPendingSourceMaps () {
    warmingScheduled = false
    for (const url of pendingUrls) {
      pendingUrls.delete(url)
      try {
        findSourceMap(url)
      } catch (error) {
        debug('Failed to warm source map for %s: %s', url, error.stack || error.message)
      }
    }
  }

  function finishWarmingSourceMaps () {
    warmPendingSourceMaps()
    session.disconnect()
  }

  session.connect()
  session.on('Debugger.scriptParsed', onScriptParsed)
  session.post('Debugger.enable')
  process.once('exit', finishWarmingSourceMaps)
}

module.exports = { markCoverageDirectory }
