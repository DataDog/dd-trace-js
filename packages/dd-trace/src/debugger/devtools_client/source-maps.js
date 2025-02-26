'use strict'

const { join, dirname } = require('path')
const { readFileSync } = require('fs')
const { readFile } = require('fs/promises')
const { SourceMapConsumer } = require('source-map')
const { NODE_MAJOR } = require('../../../../../version')

const cache = new Map()
let cacheTimer = null
let cacheTime = null

const self = module.exports = {
  async loadSourceMap (dir, url) {
    if (url.startsWith('data:')) return loadInlineSourceMap(url)
    const path = join(dir, url)
    if (cache.has(path)) return cache.get(path)
    return cacheIt(path, JSON.parse(await readFile(path, 'utf8')))
  },

  loadSourceMapSync (dir, url) {
    if (url.startsWith('data:')) return loadInlineSourceMap(url)
    const path = join(dir, url)
    if (cache.has(path)) return cache.get(path)
    return cacheIt(path, JSON.parse(readFileSync(path, 'utf8')))
  },

  async getGeneratedPosition (url, source, line, sourceMapURL) {
    const dir = dirname(new URL(url).pathname)
    return await SourceMapConsumer.with(
      await self.loadSourceMap(dir, sourceMapURL),
      null,
      (consumer) => consumer.generatedPositionFor({ source, line, column: 0 })
    )
  }
}

// The version check inside this function is to guard against a bug Node.js version 18, in which calls to `setTimeout`
// might throw an uncatchable error from within `AsyncLocalStorage._propagate` with the following error message:
//
//     TypeError: Cannot read properties of undefined (reading 'Symbol(kResourceStore)')
//
// Source: https://github.com/nodejs/node/blob/v18.20.6/lib/async_hooks.js#L312
function cacheIt (key, value) {
  if (NODE_MAJOR < 20) return value
  cacheTime = Date.now()
  setCacheTTL()
  cache.set(key, value)
  return value
}

function setCacheTTL () {
  if (cacheTimer !== null) return

  cacheTimer = setTimeout(function () {
    cacheTimer = null
    if (Date.now() - cacheTime < 2_500) {
      // If the last cache entry was added recently, keep the cache alive
      setCacheTTL()
    } else {
      // Optimize for app boot, where a lot of reads might happen
      // Clear cache a few seconds after it was last used
      cache.clear()
    }
  }, 5_000).unref()
}

function loadInlineSourceMap (data) {
  data = data.slice(data.indexOf('base64,') + 7)
  return JSON.parse(Buffer.from(data, 'base64').toString('utf8'))
}
