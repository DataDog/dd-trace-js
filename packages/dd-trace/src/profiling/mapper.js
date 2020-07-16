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

  async getSource (callFrame) {
    const { url, lineNumber, columnNumber, functionName } = callFrame
    const key = `${url}:${functionName}:${lineNumber}:${columnNumber}`

    if (!this._sources[key]) {
      this._sources[key] = await this._getMapping(callFrame)
    }

    return this._sources[key]
  }

  async _getConsumer (url) {
    if (this._consumers[url] === undefined) {
      this._consumers[url] = this._createConsumer(url)
    }

    return this._consumers[url]
  }

  async _createConsumer (url) {
    try {
      const map = await this._resolve(url)

      return map ? new SourceMapConsumer(map) : null
    } catch (e) {
      return null
    }
  }

  async _getMapping (callFrame) {
    const { url, functionName, lineNumber, columnNumber } = callFrame

    // Runtime.CallFrame is 0-based for both line and column numbers.
    // When the line or column number is not known the value is -1.
    // https://chromedevtools.github.io/devtools-protocol/v8/Runtime/#type-CallFrame
    if (lineNumber < 0 || columnNumber < 0) return callFrame

    const consumer = await this._getConsumer(url)

    if (!consumer) return callFrame

    // SourceMapConsumer is 1-based for lines and 0-based for columns
    // https://github.com/mozilla/source-map/blob/0.7.3/lib/source-map-consumer.js#L464-L487
    const map = consumer.originalPositionFor({
      line: lineNumber + 1,
      column: columnNumber
    })

    if (!map || !map.source || !map.line) return callFrame

    return {
      url: pathToFileURL(map.source).href,
      lineNumber: map.line - 1, // reset to 0-based from 1-based
      columnNumber: map.column !== null ? map.column : -1,
      functionName: map.name || functionName
    }
  }

  async _resolve (url) {
    const filename = fileURLToPath(url)
    const code = (await fs.promises.readFile(filename)).toString()

    return new Promise((resolve, reject) => {
      sourceMapResolve.resolve(code, filename, fs.readFile, (error, result) => {
        if (!result || error) return resolve(null)

        result.map.sourcesContent = result.sourcesContent
        result.map.sources = result.sourcesResolved

        resolve(result.map)
      })
    })
  }
}

module.exports = { SourceMapper }
