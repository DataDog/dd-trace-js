'use strict'

const fs = require('node:fs')

async function isExtensionRunning () {
  try {
    await fs.promises.access('/opt/extensions/datadog-agent', fs.constants.F_OK)
    return true
  } catch {
    return false
  }
}

module.exports = { isExtensionRunning }
