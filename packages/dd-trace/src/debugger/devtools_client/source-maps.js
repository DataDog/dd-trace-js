'use strict'

const { join, dirname } = require('path')
const { readFileSync } = require('fs')
const { readFile } = require('fs/promises')
const { SourceMapConsumer } = require('source-map')

const cache = new Map()
let cacheTimer = null
let cacheTimerLastSet = 0

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

// TODO: Remove if-statement around `setTimeout` below once it's safe to do so.
//
// This is a workaround for, what seems like a bug in Node.js core, that seems to trigger when, among other things, a
// lot of timers are being created very rapidly. This makes the call to `setTimeout` throw an error from within
// `AsyncLocalStorage._propagate` with the following error message:
//
//     TypeError: Cannot read properties of undefined (reading 'Symbol(kResourceStore)')
//
// Source: https://github.com/nodejs/node/blob/v18.20.6/lib/async_hooks.js#L312
function cacheIt (key, value) {
  const now = Date.now()
  if (now > cacheTimerLastSet + 1_000) {
    clearTimeout(cacheTimer)
    cacheTimer = setTimeout(function () {
      // Optimize for app boot, where a lot of reads might happen
      // Clear cache a few seconds after it was last used
      cache.clear()
    }, 10_000).unref()
    cacheTimerLastSet = now
  }
  cache.set(key, value)
  return value
}

function loadInlineSourceMap (data) {
  data = data.slice(data.indexOf('base64,') + 7)
  return JSON.parse(Buffer.from(data, 'base64').toString('utf8'))
}
