'use strict'

const fs = require('fs')
const path = require('path')

const INSTRUMENTATIONS_PATH = path.join(__dirname, '../../../../datadog-instrumentations/src')
const INSTRUMENT_HELPER_PATH = path.join(
  INSTRUMENTATIONS_PATH, 'helpers/instrument'
)
const ORCHESTRION_INSTRUMENTATIONS_PATH = path.join(
  INSTRUMENTATIONS_PATH, 'helpers/rewriter/instrumentations'
)

/**
 * Adds the package metadata declared by an integration's Orchestrion configuration.
 *
 * @param {string} name - Integration name.
 * @param {Array<{name: string, versions: string[], file?: string}>} instrumentations - Discovered instrumentations.
 * @returns {void}
 */
function loadOrchestrionInstrumentations (name, instrumentations) {
  const configPath = path.join(ORCHESTRION_INSTRUMENTATIONS_PATH, `${name}.js`)
  if (!fs.existsSync(configPath)) return

  const seen = new Set(instrumentations.map(({ name, versions, file }) => `${name}\0${versions?.join()}\0${file}`))

  for (const { module } of require(configPath)) {
    const { name, versionRange, filePath } = module
    const key = `${name}\0${versionRange}\0${filePath}`
    if (seen.has(key)) continue

    seen.add(key)
    instrumentations.push({ name, versions: [versionRange], file: filePath })
  }
}

function loadInstFile (file, instrumentations) {
  const instPath = path.join(INSTRUMENTATIONS_PATH, file)

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
  const instrumentationPath = path.join(INSTRUMENTATIONS_PATH, name)

  if (fs.existsSync(instrumentationPath) || fs.existsSync(`${instrumentationPath}.js`)) {
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
  }

  loadOrchestrionInstrumentations(name, instrumentations)

  const uniqueInstrumentations = []
  const seen = new Set()

  for (const instrumentation of instrumentations) {
    const { name, versions, file, filePattern } = instrumentation
    const key = `${name}\0${versions?.join()}\0${file}\0${filePattern}`
    if (seen.has(key)) continue

    seen.add(key)
    uniqueInstrumentations.push(instrumentation)
  }

  return uniqueInstrumentations
}

/**
 * Returns every integration name declared by a runtime module or Orchestrion configuration.
 *
 * @returns {string[]}
 */
function getInstrumentationNames () {
  const names = new Set(fs.readdirSync(INSTRUMENTATIONS_PATH)
    .filter(file => file.endsWith('.js'))
    .map(file => file.slice(0, -3)))

  for (const file of fs.readdirSync(ORCHESTRION_INSTRUMENTATIONS_PATH)) {
    if (file !== 'index.js' && file.endsWith('.js')) names.add(file.slice(0, -3))
  }

  return [...names]
}

function getAllInstrumentations () {
  return getInstrumentationNames().reduce((acc, key) => {
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
  getInstrumentationNames,
}
