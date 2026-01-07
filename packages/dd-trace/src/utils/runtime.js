'use strict'

/**
 * Detects the JavaScript runtime environment
 * @returns {{ name: string, version: string, isBun: boolean, isNode: boolean }}
 */
function detectRuntime () {
  // Bun sets process.isBun = true
  if (typeof process !== 'undefined' && process.isBun === true) {
    return {
      name: 'bun',
      version: process.versions?.bun || 'unknown',
      isBun: true,
      isNode: false,
    }
  }

  // Node.js detection
  if (typeof process !== 'undefined' && process.versions?.node) {
    return {
      name: 'node',
      version: process.versions.node,
      isBun: false,
      isNode: true,
    }
  }

  // Fallback
  return {
    name: 'unknown',
    version: 'unknown',
    isBun: false,
    isNode: false,
  }
}

const runtime = detectRuntime()

module.exports = {
  runtime,
  isBun: runtime.isBun,
  isNode: runtime.isNode,
  runtimeName: runtime.name,
  runtimeVersion: runtime.version,
}
