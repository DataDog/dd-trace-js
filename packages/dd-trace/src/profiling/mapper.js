'use strict'

// TODO: use sourceRoot when set, possibly from source-map-resolve

const fs = require('fs')
const { SourceMapConsumer } = require('source-map')
const sourceMapResolve = require('source-map-resolve')
const { fileURLToPath, pathToFileURL } = require('url')

class SourceMapper {
  constructor () {
    this._consumers = Object.create(null)
    this._sources = Object.create(null)
  }

  async map (callFrame) {
    return this._getSource(callFrame)
  }

  async _getConsumer (url) {
    if (this._consumers[url] === undefined) {
      this._consumers[url] = this._createConsumer(url)
    }

    return this._consumers[url]
  }

  async _createConsumer (url) {
    const map = await this._resolve(url)

    return map ? new SourceMapConsumer(map) : null
  }

  async _getSource (callFrame) {
    const { url, lineNumber, columnNumber } = callFrame
    const key = `${url}:${lineNumber}:${columnNumber}`

    if (!this._sources[key]) {
      this._sources[key] = await this._getMapping(callFrame)
    }

    return this._sources[key]
  }

  async _getMapping (callFrame) {
    const { url, functionName, lineNumber, columnNumber } = callFrame
    const consumer = await this._getConsumer(url)

    if (!consumer) return callFrame

    const map = consumer.originalPositionFor({
      line: lineNumber,
      column: columnNumber
    })

    if (!map || !map.source || !map.line) return callFrame

    return {
      url: pathToFileURL(map.source).href,
      lineNumber: map.line,
      columnNumber: map.column || -1,
      functionName: map.name || functionName
    }
  }

  async _resolve (url) {
    try {
      const filename = fileURLToPath(url)
      const code = (await fs.promises.readFile(filename)).toString()

      return await new Promise((resolve, reject) => {
        sourceMapResolve.resolve(code, filename, fs.readFile, (error, result) => {
          if (!result || error) return resolve(null)

          result.map.sourcesContent = result.sourcesContent
          result.map.sources = result.sourcesResolved

          resolve(result.map)
        })
      })
    } catch (e) {
      return null
    }
  }
}

module.exports = { SourceMapper }
