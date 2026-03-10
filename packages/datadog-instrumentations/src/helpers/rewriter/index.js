'use strict'

const { readFileSync } = require('fs')
const { join } = require('path')
const log = require('../../../../dd-trace/src/log')
const instrumentations = require('./instrumentations')
const { create } = require('./orchestrion')

/** @type {Record<string, string>} map of module base name to version */
const moduleVersions = {}
const disabled = new Set()
const matcher = create(instrumentations, 'dc-polyfill')

function rewrite (content, filename, format) {
  if (!content) return content
  if (!filename.includes('node_modules')) return content

  filename = filename.replace('file://', '')

  const moduleType = format === 'module' ? 'esm' : 'cjs'
  const [modulePath] = filename.split('/node_modules/').reverse()
  const moduleParts = modulePath.split('/')
  const splitIndex = moduleParts[0].startsWith('@') ? 2 : 1
  const moduleName = moduleParts.slice(0, splitIndex).join('/')
  const filePath = moduleParts.slice(splitIndex).join('/')
  const version = getVersion(filename, filePath)

  if (disabled.has(moduleName)) return content

  const transformer = matcher.getTransformer(moduleName, version, filePath)

  if (!transformer) return content

  try {
    // TODO: pass existing sourcemap as input for remapping
    const { code, map } = transformer.transform(content, moduleType)

    if (!map) return code

    const inlineMap = Buffer.from(map).toString('base64')

    return code + '\n' + `//# sourceMappingURL=data:application/json;base64,${inlineMap}`
  } catch (e) {
    log.error(e)
  }

  return content
}

function disable (instrumentation) {
  disabled.add(instrumentation)
}

function getVersion (filename, filePath) {
  const [basename] = filename.split(filePath)

  if (!moduleVersions[basename]) {
    try {
      const pkg = JSON.parse(readFileSync(
        join(basename, 'package.json'), 'utf8'
      ))

      moduleVersions[basename] = pkg.version
    } catch {}
  }

  return moduleVersions[basename]
}

module.exports = { rewrite, disable }
