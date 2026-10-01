#!/usr/bin/env node

'use strict'

const { execFileSync } = require('node:child_process')

const MINIMUM_VERSION = '0.1.12'

function verifySirunVersion () {
  const output = execFileSync('sirun', ['--version'], { encoding: 'utf8' }).trim()
  assertSirunVersion(output)
}

/**
 * @param {string} output
 */
function assertSirunVersion (output) {
  const match = output.match(/\b(\d+)\.(\d+)\.(\d+)\b/)
  if (!match) throw new Error(`Could not parse Sirun version from: ${output}`)

  const actual = match.slice(1).map(Number)
  const minimum = MINIMUM_VERSION.split('.').map(Number)
  for (let index = 0; index < minimum.length; index++) {
    if (actual[index] > minimum[index]) return
    if (actual[index] < minimum[index]) {
      throw new Error(`Sirun ${MINIMUM_VERSION} or newer is required; found ${match[0]}`)
    }
  }
}

if (require.main === module) verifySirunVersion()

module.exports = { MINIMUM_VERSION, assertSirunVersion, verifySirunVersion }
