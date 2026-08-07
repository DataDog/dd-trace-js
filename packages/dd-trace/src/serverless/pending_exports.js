'use strict'

const { getEnvironmentVariable } = require('../config/helper')

const pending = new Set()
const noop = () => {}

function trackExport () {
  if (getEnvironmentVariable('VERCEL') !== '1') return noop

  let resolve
  const exportPromise = new Promise((_resolve) => { resolve = _resolve })
  pending.add(exportPromise)

  return () => {
    pending.delete(exportPromise)
    resolve()
  }
}

async function waitForPendingExports () {
  while (pending.size) {
    await Promise.allSettled([...pending])
  }
}

module.exports = { trackExport, waitForPendingExports }
