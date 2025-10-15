'use strict'

const { expect } = require('chai')
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
  'datadog-plugin-mongoose' // mongoose tracing is done through mongodb-core instrumentation
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
        expect(pluginId).to.equal(expectedId)
      })

      it('should have a corresponding instrumentation file', () => {
        if (abstractPlugins.includes(pluginId)) {
          return
        }

        expect(instrumentationFiles.has(pluginId))
          .to.equal(true, `Missing instrumentation file: ${pluginId}.js`)
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

    expect(missingInstrumentations).to.be.empty
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

    expect(missingHooks).to.deep.equal(missingInstrumentationHooks)
  })
})
