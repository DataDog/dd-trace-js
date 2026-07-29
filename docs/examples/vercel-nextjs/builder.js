'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')

const WRAPPER_FILE = '___datadog_next_launcher.cjs'

function wrapperSource (handler) {
  if (typeof handler !== 'string' || handler.length === 0) {
    throw new TypeError('Vercel Node function handler must be a non-empty string')
  }

  const modulePath = handler.startsWith('.') ? handler : `./${handler}`

  return `'use strict'

require('dd-trace/init')
module.exports = require(${JSON.stringify(modulePath)})
`
}

async function findFunctionPaths (directory) {
  const functionPaths = []

  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue

    const entryPath = path.join(directory, entry.name)
    if (entry.name.endsWith('.func')) {
      functionPaths.push(entryPath)
    } else {
      functionPaths.push(...await findFunctionPaths(entryPath))
    }
  }

  return functionPaths
}

async function instrumentBuildOutput (outputPath) {
  const functionPaths = await findFunctionPaths(path.join(outputPath, 'functions'))

  for (const functionPath of functionPaths) {
    const configPath = path.join(functionPath, '.vc-config.json')
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'))

    if (!String(config.runtime).startsWith('nodejs') || config.handler === WRAPPER_FILE) continue

    await fs.writeFile(path.join(functionPath, WRAPPER_FILE), wrapperSource(config.handler))
    config.handler = WRAPPER_FILE
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
  }
}

async function build (options) {
  // Load Vercel's official Builder only when Vercel invokes this entry point.
  const { build: buildNext } = require('@vercel/next')
  const result = await buildNext(options)

  if (result.buildOutputPath) await instrumentBuildOutput(result.buildOutputPath)

  return result
}

module.exports = {
  build,
  instrumentBuildOutput,
}
