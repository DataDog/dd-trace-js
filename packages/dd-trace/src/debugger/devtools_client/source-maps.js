'use strict'

const { join, dirname } = require('path')
const { readFileSync } = require('fs')
const { readFile } = require('fs/promises')
const { SourceMapConsumer } = require('source-map')

const self = module.exports = {
  async loadSourceMap (dir, url) {
    if (url.startsWith('data:')) return loadInlineSourceMap(url)
    const path = join(dir, url)
    return JSON.parse(await readFile(path, 'utf8'))
  },

  loadSourceMapSync (dir, url) {
    if (url.startsWith('data:')) return loadInlineSourceMap(url)
    const path = join(dir, url)
    return JSON.parse(readFileSync(path, 'utf8'))
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

function loadInlineSourceMap (data) {
  data = data.slice(data.indexOf('base64,') + 7)
  return JSON.parse(Buffer.from(data, 'base64').toString('utf8'))
}
