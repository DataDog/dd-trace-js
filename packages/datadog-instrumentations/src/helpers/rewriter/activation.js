'use strict'

const { channel } = require('dc-polyfill')

const loadChannel = channel('dd-trace:instrumentation:load')
const reported = new Set()

/**
 * Publishes activation metadata once for each transformed package file.
 *
 * @param {{ name: string, version: string, file: string }} metadata
 * @returns {void}
 */
function report (metadata) {
  const key = `${metadata.name}\0${metadata.version}\0${metadata.file}`
  if (reported.has(key)) return

  reported.add(key)
  loadChannel.publish(metadata)
}

module.exports = { report }
