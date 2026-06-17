'use strict'

const fs = require('fs')
const path = require('path')

const { validateManifest } = require('./manifest-schema')

function loadManifest (manifestPath) {
  const resolvedPath = path.resolve(manifestPath)
  const raw = fs.readFileSync(resolvedPath, 'utf8')
  const manifest = JSON.parse(raw)
  manifest.__path = resolvedPath

  const errors = validateManifest(manifest)
  if (errors.length > 0) {
    throw new Error(`Invalid validation manifest:\n- ${errors.join('\n- ')}`)
  }

  return manifest
}

module.exports = { loadManifest }
