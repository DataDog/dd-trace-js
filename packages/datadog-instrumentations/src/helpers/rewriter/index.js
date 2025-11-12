'use strict'

// The rewriter works effectively the same as Orchestrion with some additions:
// - Supports an `astQuery` field to filter AST nodes with an esquery query.
// - Supports replacing methods of child class instance in the base constructor.

const { readFileSync } = require('fs')
const { join } = require('path')
const semifies = require('semifies')
const codeTransformer = require('@apm-js-collab/code-transformer')
const log = require('../../../../dd-trace/src/log')
const instrumentations = require('./instrumentations.json')

const supported = {}
const versions = {}
const disabled = new Set()

const matcher = codeTransformer.create(instrumentations)

function rewrite (content, filename, format) {
  if (!content) return content

  try {
    filename = filename.replace('file://', '')

    for (const inst of instrumentations) {
      const { module: { name, versionRange, filePath } } = inst

      if (disabled.has(name)) continue
      if (!filename.endsWith(`${name}/${filePath}`)) continue
      if (!satisfies(filename, filePath, versionRange)) continue

      const version = getVersion(filename, filePath)
      const transformer = matcher.getTransformer(name, version, filePath)

      if (!transformer) continue

      const { code } = transformer.transform(content, 'unknown')

      content = code

      transformer.free()
    }
  } catch (e) {
    log.error(e)
  }

  return content
}

function disable (instrumentation) {
  disabled.add(instrumentation)
}

function satisfies (filename, filePath, versions) {
  const [basename] = filename.split(filePath)

  if (supported[basename] === undefined) {
    try {
      supported[basename] = semifies(getVersion(basename), versions)
    } catch {
      supported[basename] = false
    }
  }

  return supported[basename]
}

function getVersion (filename, filePath) {
  const [basename] = filename.split(filePath)

  if (!versions[basename]) {
    const pkg = JSON.parse(readFileSync(
      join(basename, 'package.json'), 'utf8'
    ))

    versions[basename] = pkg.version
  }

  return versions[basename]
}

module.exports = { rewrite, disable }
