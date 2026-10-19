'use strict'

const { wrapDeclaration } = require('../../dd-trace/src/ci-visibility/test-declaration-annotations')
const { addHook } = require('./helpers/instrument')
const { findExportByName } = require('./vitest-util')

/** @param {Record<string, unknown>} pkg */
function captureDeclarations (pkg) {
  const getCurrentSuite = findExportByName(pkg, 'getCurrentSuite')?.value
  if (!getCurrentSuite) return pkg
  for (const [name, value] of Object.entries(pkg)) {
    if (typeof value !== 'function' || !('each' in value) || !('extend' in value)) continue
    pkg[name] = wrapDeclaration(value, getCurrentSuite)
  }
  return pkg
}

addHook({ name: '@vitest/runner', versions: ['>=1.6.0 <5.0.0'] }, captureDeclarations)
addHook({ name: 'vitest', versions: ['>=5.0.0'], filePattern: 'dist/chunks/run.*' }, captureDeclarations)
