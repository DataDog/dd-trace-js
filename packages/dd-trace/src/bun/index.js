'use strict'

// Bun-specific code lives in this directory, so it can be found, reviewed, and removed in one place. Detect Bun
// through this module instead of reading `process.versions.bun` elsewhere. Bun reports a Node.js `process.version`.

const isBun = process.versions.bun !== undefined

module.exports = { isBun }
