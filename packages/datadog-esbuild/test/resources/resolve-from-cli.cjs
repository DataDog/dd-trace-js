'use strict'

const { pathToFileURL } = require('node:url')

const { createEsmResolver } = require('../../src/resolver')

async function main () {
  const resolver = createEsmResolver()
  try {
    process.stdout.write(await resolver.resolve(process.argv[2], pathToFileURL(__filename)))
  } finally {
    await resolver.close()
  }
}

main()
