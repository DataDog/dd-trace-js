'use strict'

const fs = require('node:fs')
const path = require('node:path')

/**
 * @param {string} filename
 * @param {string|Buffer} content
 */
function replaceFile (filename, content) {
  const temporaryFile = path.join(
    path.dirname(filename),
    `.${path.basename(filename)}.${process.pid}.tmp`
  )

  try {
    const { mode } = fs.statSync(filename)
    // Bun hardlinks cached packages on Linux and Windows with either linker. Keep patches out of the shared cache.
    fs.writeFileSync(temporaryFile, content, { mode })
    fs.renameSync(temporaryFile, filename)
  } finally {
    fs.rmSync(temporaryFile, { force: true })
  }
}

module.exports = { replaceFile }
