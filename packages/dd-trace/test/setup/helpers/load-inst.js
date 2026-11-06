'use strict'

const fs = require('fs')
const path = require('path')

const INSTRUMENTATIONS_PATH = path.join(__dirname, '../../../../datadog-instrumentations/src')
const INSTRUMENT_HELPER_PATH = path.join(
  INSTRUMENTATIONS_PATH, 'helpers/instrument'
)
const REWRITER_INSTRUMENTATIONS_PATH = path.join(
  INSTRUMENTATIONS_PATH, 'helpers/rewriter/instrumentations'
)
const subscriberOnlyFiles = new Set()

function loadInstFile (file, instrumentations, cacheSubscribers = false) {
  const instPath = path.join(INSTRUMENTATIONS_PATH, file)
  if (cacheSubscribers && subscriberOnlyFiles.has(instPath) && require.cache[instPath]) return

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

  // Hook files must be re-evaluated by register.js, but subscriber-only entries
  // must stay cached so discovery does not duplicate their runtime subscribers.
  const cacheBefore = new Set(Object.keys(require.cache))
  const hookCount = instrumentations.length

  try {
    delete require.cache[instPath]
    require(instPath)
    if (cacheSubscribers && instrumentations.length === hookCount) {
      subscriberOnlyFiles.add(instPath)
      cacheBefore.add(instPath)
    }
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
  const splitFiles = [`${name}/server.js`, `${name}/client.js`]
  const mainFile = `${name}/main.js`
  const singleFile = `${name}.js`

  if (splitFiles.every(file => fs.existsSync(path.join(INSTRUMENTATIONS_PATH, file)))) {
    for (const file of splitFiles) loadInstFile(file, instrumentations)
  } else if (fs.existsSync(path.join(INSTRUMENTATIONS_PATH, mainFile))) {
    loadInstFile(mainFile, instrumentations)
  } else {
    const hasSingleFile = fs.existsSync(path.join(INSTRUMENTATIONS_PATH, singleFile))
    const rewriterFile = path.join(REWRITER_INSTRUMENTATIONS_PATH, name)
    const hasRewriterFile = fs.existsSync(`${rewriterFile}.js`)
    if (hasSingleFile) {
      loadInstFile(singleFile, instrumentations, hasRewriterFile)
      if (instrumentations.length) return instrumentations
    }

    if (!hasRewriterFile) {
      if (!hasSingleFile) loadInstFile(singleFile, instrumentations)
      return instrumentations
    }

    const definitions = require(rewriterFile)
    const names = new Set(definitions.map(definition => definition.module.name))
    instrumentations.push(...require(INSTRUMENT_HELPER_PATH).getHooks([...names]).values())
  }

  return instrumentations
}

/**
 * Return integration keys backed by a real instrumentation entrypoint or a rewriter configuration.
 *
 * @returns {string[]}
 */
function getInstrumentationNames () {
  const names = new Set()

  for (const file of fs.readdirSync(INSTRUMENTATIONS_PATH)) {
    if (file.endsWith('.js') && file !== 'index.js') names.add(file.slice(0, -3))
  }
  for (const file of fs.readdirSync(REWRITER_INSTRUMENTATIONS_PATH)) {
    if (file.endsWith('.js') && file !== 'index.js') names.add(file.slice(0, -3))
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
