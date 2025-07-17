'use strict'

const { join, dirname } = require('path')
const { readFileSync } = require('fs')
const { readFile } = require('fs/promises')
const { SourceMapConsumer } = require('source-map')

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
    return SourceMapConsumer.with(
      await self.loadSourceMap(dir, sourceMapURL),
      null,
      (consumer) => consumer.generatedPositionFor({ source, line, column: 0 })
    )
  }
}

function cacheIt (key, value) {
  cacheTime = Date.now()
  setCacheTTL()
  cache.set(key, value)
  return value
}

function setCacheTTL () {
  if (cacheTimer !== null) return

  cacheTimer = setTimeout(function () {
    cacheTimer = null
    if (Date.now() - cacheTime < 2500) {
      // If the last cache entry was added recently, keep the cache alive
      setCacheTTL()
    } else {
      // Optimize for app boot, where a lot of reads might happen
      // Clear cache a few seconds after it was last used
      cache.clear()
    }
  }, 5000).unref()
}

function loadInlineSourceMap (data) {
  data = data.slice(data.indexOf('base64,') + 7)
  return JSON.parse(Buffer.from(data, 'base64').toString('utf8'))
}
