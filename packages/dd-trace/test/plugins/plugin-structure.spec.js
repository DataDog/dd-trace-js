'use strict'

const assert = require('node:assert/strict')
const { describe, it, before } = require('tap').mocha
const fs = require('node:fs')
const path = require('node:path')

require('../setup/core')

const hooks = require('../../../datadog-instrumentations/src/helpers/hooks')

const abstractPlugins = [
  'web' // web is an abstract plugin, and will not have an instrumentation file
]

// we have some plugin directories that we don't actually have a tracing plugin for, but exist for special cases
// outlined below. We filter them out of the plugin structure validation.
const missingPlugins = [
  'datadog-plugin-axios', // we test axios to ensure our functionality works with axios, see: https://github.com/DataDog/dd-trace-js/pull/1469
  'datadog-plugin-limitd-client', // limitd-client instrumentation handles trace context propagation, no tracing is done
  'datadog-plugin-mongoose', // mongoose tracing is done through mongodb-core instrumentation
  'datadog-plugin-cookie-parser', // cookie-parser does not produce spans
  'datadog-plugin-express-session', // express-session does not produce spans
  'datadog-plugin-express-mongo-sanitize', // express-mongo-sanitize does not produce spans
  'datadog-plugin-multer', // multer does not produce spans
  'datadog-plugin-url', // url does not produce spans
  'datadog-plugin-passport-http', // passport-http does not produce spans
  'datadog-plugin-knex', // knex does not produce spans
  'datadog-plugin-node-serialize', // node-serialize does not produce spans
  'datadog-plugin-generic-pool', // generic-pool does not produce spans
  'datadog-plugin-lodash', // lodash does not produce spans
  'datadog-plugin-ldapjs', // ldapjs does not produce spans
  'datadog-plugin-cookie', // cookie does not produce spans
  'datadog-plugin-crypto', // crypto does not produce spans
  'datadog-plugin-handlebars', // handlebars does not produce spans
  'datadog-plugin-process', // process does not produce spans
  'datadog-plugin-pug', // pug does not produce spans
  'datadog-plugin-vm', // vm does not produce spans
  'datadog-plugin-sequelize', // sequelize does not produce spans
]

// instrumentations that do not have a hook, but are still instrumented
const missingInstrumentationHooks = [
  'fetch' // fetch is provided by Node.js, and is automatically instrumented if it exists
]

describe('Plugin Structure Validation', () => {
  const packagesDir = path.join(__dirname, '..', '..', '..')
  const instrumentationsDir = path.join(packagesDir, 'datadog-instrumentations', 'src')

  let pluginDirs
  let instrumentationFiles
  let allPluginIds

  before(() => {
    pluginDirs = fs.readdirSync(packagesDir)
      .filter(dir => dir.startsWith('datadog-plugin-') && !missingPlugins.includes(dir))

    instrumentationFiles = new Set(
      fs.readdirSync(instrumentationsDir)
        .filter(file => file.endsWith('.js'))
        .map(file => file.replace('.js', ''))
    )

    allPluginIds = new Set(pluginDirs.map(dir => dir.replace('datadog-plugin-', '')))
  })

  pluginDirs.forEach(pluginDir => {
    const expectedId = pluginDir.replace('datadog-plugin-', '')

    describe(`Plugin: ${pluginDir}`, () => {
      const pluginPath = path.join(packagesDir, pluginDir, 'src', 'index.js')
      const Plugin = require(pluginPath)
      const pluginId = Plugin.id

      it('should have an id that matches the directory name', () => {
        assert.strictEqual(pluginId, expectedId)
      })

      it('should have a corresponding instrumentation file', () => {
        if (abstractPlugins.includes(pluginId)) {
          return
        }

        assert.strictEqual(instrumentationFiles.has(pluginId), true, `Missing instrumentation file: ${pluginId}.js`)
      })
    })
  })

  it('should have all plugins accounted for with an instrumentation file', () => {
    const missingInstrumentations = []

    allPluginIds.forEach(pluginId => {
      if (!instrumentationFiles.has(pluginId) && !abstractPlugins.includes(pluginId)) {
        missingInstrumentations.push(pluginId)
      }
    })

    assert.strictEqual(missingInstrumentations.length, 0)
  })

  it('should have all plugins accounted for with a hook', () => {
    const instrumentationsRequired = new Set()

    for (const hook of Object.values(hooks)) {
      let hookFn = hook
      if (typeof hook === 'object' && hook.fn) {
        hookFn = hook.fn
      }
      const hookString = hookFn.toString()
      const match = hookString.match(/require\('([^']*)'\)/)
      if (match && match[1]) {
        const instrumentationName = match[1].replace('../', '')
        instrumentationsRequired.add(instrumentationName)
      }
    }

    const missingHooks = []
    allPluginIds.forEach(pluginId => {
      if (!instrumentationsRequired.has(pluginId) && !abstractPlugins.includes(pluginId)) {
        missingHooks.push(pluginId)
      }
    })

    assert.deepStrictEqual(missingHooks, missingInstrumentationHooks)
  })
})
