'use strict'

require('../setup/tap')

const { expect } = require('chai')

const fs = require('fs')
const path = require('path')

const abstractPlugins = [
  'web' // web is an abstract plugin, and will not have an instrumentation file
]

describe('Plugin Structure Validation', () => {
  const packagesDir = path.join(__dirname, '..', '..', '..')
  const instrumentationsDir = path.join(packagesDir, 'datadog-instrumentations', 'src')

  let pluginDirs
  let allPluginIds
  let instrumentationFiles

  before(() => {
    pluginDirs = fs.readdirSync(packagesDir)
      .filter(dir => dir.startsWith('datadog-plugin-'))
      .filter(dir => {
        const pluginPath = path.join(packagesDir, dir, 'src', 'index.js')
        return fs.existsSync(pluginPath)
      })

    allPluginIds = new Set()
    instrumentationFiles = new Set(
      fs.readdirSync(instrumentationsDir)
        .filter(file => file.endsWith('.js'))
        .map(file => file.replace('.js', ''))
    )
  })

  pluginDirs.forEach(pluginDir => {
    const expectedId = pluginDir.replace('datadog-plugin-', '')

    describe(`Plugin: ${pluginDir}`, () => {
      let Plugin
      let pluginId

      beforeEach(() => {
        const pluginPath = path.join(packagesDir, pluginDir, 'src', 'index.js')
        delete require.cache[require.resolve(pluginPath)]
        Plugin = require(pluginPath)
        pluginId = Plugin.id
        allPluginIds.add(pluginId)
      })

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

      it('should export a class with a static id getter', () => {
        expect(Plugin).to.be.a('function')
        expect(Plugin.id).to.be.a('string')
        expect(Plugin.id).to.not.be.empty
      })
    })
  })

  it('should have no duplicate plugin IDs', () => {
    const duplicates = []
    const seenIds = new Set()

    pluginDirs.forEach(pluginDir => {
      const pluginPath = path.join(packagesDir, pluginDir, 'src', 'index.js')
      const Plugin = require(pluginPath)
      const id = Plugin.id

      if (seenIds.has(id)) {
        duplicates.push(id)
      } else {
        seenIds.add(id)
      }
    })

    expect(duplicates).to.be.empty
  })

  it('should have all plugins accounted for in instrumentations', () => {
    const missingInstrumentations = []

    allPluginIds.forEach(pluginId => {
      if (!instrumentationFiles.has(pluginId) && !abstractPlugins.includes(pluginId)) {
        missingInstrumentations.push(pluginId)
      }
    })

    expect(missingInstrumentations).to.be.empty
  })
})
