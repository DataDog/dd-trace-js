'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')

const { FileBlob } = require('@vercel/build-utils')
const vercelNext = require('@vercel/next')

const WRAPPER_FILE = '___datadog_next_launcher.cjs'

function wrapperSource (originalHandler) {
  return `'use strict'

require('dd-trace/init')
module.exports = require(${JSON.stringify(`./${originalHandler}`)})
`
}

function instrumentNodeLambdas (result) {
  const visited = new Set()

  for (const output of Object.values(result.output || {})) {
    if (!output || output.type !== 'Lambda' || !String(output.runtime).startsWith('nodejs')) continue
    if (visited.has(output)) continue
    visited.add(output)

    const originalHandler = output.handler
    output.files = {
      ...output.files,
      [WRAPPER_FILE]: new FileBlob({ data: wrapperSource(originalHandler) }),
    }
    output.handler = WRAPPER_FILE
  }
}

async function instrumentBuildOutput (outputPath) {
  const functionsPath = path.join(outputPath, 'functions')
  const functionPaths = await findFunctionPaths(functionsPath)

  for (const functionPath of functionPaths) {
    const configPath = path.join(functionPath, '.vc-config.json')
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'))
    if (!String(config.runtime).startsWith('nodejs')) continue

    await fs.writeFile(
      path.join(functionPath, WRAPPER_FILE),
      wrapperSource(config.handler)
    )
    config.handler = WRAPPER_FILE
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
  }
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

async function build (options) {
  const result = await vercelNext.build(options)
  if (result.buildOutputPath) {
    await instrumentBuildOutput(result.buildOutputPath)
  } else {
    instrumentNodeLambdas(result)
  }
  return result
}

module.exports = {
  ...vercelNext,
  build,
}
