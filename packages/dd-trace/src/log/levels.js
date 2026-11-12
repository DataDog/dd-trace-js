'use strict'

// The guardrails logger requires this file, so it has to parse on Node.js 0.8.
module.exports = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  critical: 50,
  off: 100
}
