'use strict'

const fs = require('fs')
const path = require('path')

const INSTRUMENT_HELPER_PATH = path.join(
  __dirname, '../../../../datadog-instrumentations/src/helpers/instrument'
)

function loadInstFile (file, instrumentations) {
  const instPath = path.join(__dirname, `../../../../datadog-instrumentations/src/${file}`)

  // Patch `addHook` for the duration of this load and filter to the SUT's own
  // call sites; addHook calls from transitively-loaded siblings (e.g.
  // `router.js` from `express.js`) are dropped — each caller has its own
  // `getInstrumentation(name)` that captures them.
  const realInstrument = require(INSTRUMENT_HELPER_PATH)
  const originalAddHook = realInstrument.addHook
  realInstrument.addHook = (instrumentation) => {
    const callerFrame = new Error().stack?.split('\n', 4)[2] ?? ''
    if (callerFrame.includes(instPath)) {
      instrumentations.push(instrumentation)
    }
  }

  // Snapshot `require.cache` and drop everything this load adds, so production's
  // `helpers/register.js` re-evaluation finds an empty cache and re-runs the
  // integration's top-level `addHook` calls.
  const cacheBefore = new Set(Object.keys(require.cache))

  try {
    delete require.cache[instPath]
    require(instPath)
  } finally {
    realInstrument.addHook = originalAddHook
    for (const id of Object.keys(require.cache)) {
      if (!cacheBefore.has(id)) {
        delete require.cache[id]
      }
    }
  }
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

  return names.reduce((acc, key) => {
    const name = key
    let instrumentations = loadOneInst(name)

    instrumentations = instrumentations.filter(i => i.versions)
    if (instrumentations.length) {
      acc[key] = instrumentations
    }

    return acc
  }, {})
}

module.exports = {
  getInstrumentation: loadOneInst,
  getAllInstrumentations,
}
