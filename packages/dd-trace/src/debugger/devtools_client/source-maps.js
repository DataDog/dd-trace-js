'use strict'

const { join } = require('path')
const { readFileSync } = require('fs')
const { readFile } = require('fs/promises')

const cache = new Map()
let cacheTimer = null

module.exports = {
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
  }
}

function cacheIt (key, value) {
  clearTimeout(cacheTimer)
  cacheTimer = setTimeout(function () {
    // Optimize for app boot, where a lot of reads might happen
    // Clear cache a few seconds after it was last used
    cache.clear()
  }, 10_000).unref()
  cache.set(key, value)
  return value
}

function loadInlineSourceMap (data) {
  data = data.slice(data.indexOf('base64,') + 7)
  return JSON.parse(Buffer.from(data, 'base64').toString('utf8'))
}
