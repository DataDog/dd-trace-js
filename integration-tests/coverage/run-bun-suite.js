'use strict'

const { BUN_BOOTSTRAP_PATH } = require('./runtime')
const { runCoverageSuite } = require('./run-suite')

// Bun ignores NODE_OPTIONS, so Bun descendants inherit the coverage bootstrap from BUN_OPTIONS
// instead. Bun does not unquote BUN_OPTIONS values, so the path is passed as-is.
const preload = `--preload=${BUN_BOOTSTRAP_PATH}`
if (!process.env.BUN_OPTIONS?.includes(preload)) {
  process.env.BUN_OPTIONS = process.env.BUN_OPTIONS ? `${preload} ${process.env.BUN_OPTIONS}` : preload
}

runCoverageSuite()
