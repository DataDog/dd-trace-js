'use strict'

const fs = require('fs')
const path = require('path')
const proxyquire = require('proxyquire')

function loadInstFile (file, instrumentations) {
  const instrument = {
    addHook (instrumentation) {
      instrumentations.push(instrumentation)
    },
  }

  const instPath = path.join(__dirname, `../../../../datadog-instrumentations/src/${file}`)

  proxyquire.noPreserveCache()(instPath, {
    './helpers/instrument': instrument,
    '../helpers/instrument': instrument,
  })
}

function loadOneInst (name) {
  const instrumentations = []

  // Check builder integrations first
  try {
    const { orchestrion } = require('../../../../datadog-integrations/src/registry')
    const entries = orchestrion.filter(e => e.module.name === name)
    if (entries.length > 0) {
      const seen = new Set()
      for (const entry of entries) {
        const key = `${entry.module.name}:${entry.module.versionRange}:${entry.module.filePath || ''}`
        if (seen.has(key)) continue
        seen.add(key)
        const hook = { name: entry.module.name, versions: [entry.module.versionRange] }
        if (entry.module.filePath) {
          hook.file = entry.module.filePath
        }
        instrumentations.push(hook)
      }
      return instrumentations
    }
  } catch {
    // Not a builder integration or registry not available
  }

  try {
    loadInstFile(`${name}/server.js`, instrumentations)
    loadInstFile(`${name}/client.js`, instrumentations)
  } catch (e) {
    try {
      loadInstFile(`${name}/main.js`, instrumentations)
    } catch (e) {
      loadInstFile(`${name}.js`, instrumentations)
    }
  }

  return instrumentations
}

function getAllInstrumentations () {
  const names = fs.readdirSync(path.join(__dirname, '../../../../', 'datadog-instrumentations', 'src'))
    .filter(file => file.endsWith('.js'))
    .map(file => file.slice(0, -3))

  // Include builder integration module names
  try {
    const { orchestrion } = require('../../../../datadog-integrations/src/registry')
    for (const entry of orchestrion) {
      if (!names.includes(entry.module.name)) {
        names.push(entry.module.name)
      }
    }
  } catch {
    // Registry not available
  }

  const instrumentations = names.reduce((acc, key) => {
    const name = key
    let instrumentations = loadOneInst(name)

    instrumentations = instrumentations.filter(i => i.versions)
    if (instrumentations.length) {
      acc[key] = instrumentations
    }

    return acc
  }, {})

  return instrumentations
}

module.exports = {
  getInstrumentation: loadOneInst,
  getAllInstrumentations,
}
