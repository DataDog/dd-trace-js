'use strict'

const pending = new Set()

function trackExport () {
  let resolve
  const exportPromise = new Promise((_resolve) => { resolve = _resolve })
  pending.add(exportPromise)

  return () => {
    pending.delete(exportPromise)
    resolve()
  }
}

function waitForPendingExports () {
  return Promise.allSettled(pending)
}

module.exports = { trackExport, waitForPendingExports }
