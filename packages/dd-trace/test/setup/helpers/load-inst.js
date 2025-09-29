'use strict'

const fs = require('fs')
const path = require('path')
const proxyquire = require('proxyquire')

function loadInstFile (file, instrumentations) {
  const instrument = {
    addHook (instrumentation) {
      instrumentations.push(instrumentation)
    }
  }

  const instPath = path.join(__dirname, `../../../../datadog-instrumentations/src/${file}`)

  proxyquire.noPreserveCache()(instPath, {
    './helpers/instrument': instrument,
    '../helpers/instrument': instrument,
    './declarative-instrumentation.js': proxyquire(
      path.join(__dirname, '../../../../datadog-instrumentations/src/declarative-instrumentation.js'), {
        './helpers/instrument': instrument
      }
    )
  })
}

function loadOneInst (name) {
  const instrumentations = []

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
  getAllInstrumentations
}
