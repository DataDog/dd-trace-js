'use strict'

const pacote = require('pacote')
const tmp = require('tmp')
const { promisify } = require('util')

const tmpDir = promisify(tmp.dir)

async function fetchAndExtract (pkgIdentifier) {
  const tempPath = await tmpDir({ unsafeCleanup: true })

  console.log(`Fetching '${pkgIdentifier}' into temporary directory: ${tempPath}`)

  await pacote.extract(pkgIdentifier, tempPath)

  return tempPath
}

module.exports = { fetchAndExtract }
