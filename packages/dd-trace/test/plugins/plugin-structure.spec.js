'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { describe, it } = require('mocha')

require('../setup/core')
const hooks = require('../../../datadog-instrumentations/src/helpers/hooks')

const abstractPlugins = [
  'web', // web is an abstract plugin, and will not have an instrumentation file
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
  'datadog-plugin-body-parser', // body-parser does not produce spans
  'datadog-plugin-light-my-request', // light-my-request does not produce spans
]

// instrumentations that do not have a hook, but are still instrumented
const missingInstrumentationHooks = [
  'fetch', // fetch is provided by Node.js, and is automatically instrumented if it exists
]

function extractPluginIds (source, re, index) {
  const ids = new Set()
  let m
  while ((m = re.exec(source))) {
    ids.add(m[index])
  }
  return ids
}

function extractPluginsInterfaceKeys (dtsSource) {
  const m = dtsSource.match(/interface Plugins\s*\{([\s\S]*?)\n\}/m)
  assert.ok(m, 'Could not find `interface Plugins { ... }` in index.d.ts')

  const body = m[1]
  return extractPluginIds(body, /^\s*"([^"]+)"\s*:\s*/gm, 1)
}

function extractRuntimePluginPackageNames (pluginsIndexSource) {
  // Example: require('../../../datadog-plugin-express/src')
  return extractPluginIds(pluginsIndexSource, /datadog-plugin-[a-z0-9_-]+/gi, 0)
}

function extractDocsApiPluginList (apiMdSource) {
  const start = apiMdSource.indexOf('<h3 id="integrations-list">Available Plugins</h3>')
  assert.ok(start !== -1, 'Could not find Available Plugins heading in docs/API.md')

  const end = apiMdSource.indexOf('<h2 id="manual-instrumentation">', start)
  assert.ok(end !== -1, 'Could not find Manual Instrumentation heading in docs/API.md')

  const section = apiMdSource.slice(start, end)
  return extractPluginIds(section, /^\* \[([^\]]+)\]\(/gm, 1)
}

function extractDocsApiH5PluginAnchors (apiMdSource) {
  const allAnchors = extractPluginIds(apiMdSource, /<h5 id="([^"]+)"><\/h5>/g, 1)
  return new Set([...allAnchors].filter(id => !id.endsWith('-tags') && !id.endsWith('-config')))
}

describe('Plugin Structure Validation', () => {
  const packagesDir = path.join(__dirname, '..', '..', '..')
  const instrumentationsDir = path.join(packagesDir, 'datadog-instrumentations', 'src')

  const pluginDirs = fs.readdirSync(packagesDir)
    .filter(dir => dir.startsWith('datadog-plugin-') && !missingPlugins.includes(dir))

  const instrumentationFiles = new Set(
    fs.readdirSync(instrumentationsDir)
      .filter(file => file.endsWith('.js'))
      .map(file => file.replace('.js', ''))
  )

  const allPluginIds = new Set(pluginDirs.map(dir => dir.replace('datadog-plugin-', '')))

  let dtsPluginKeys
  let apiMdSource

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

  before(() => {
    const repoRoot = path.join(packagesDir, '..')

    const dtsPath = path.join(repoRoot, 'index.d.ts')
    const apiMdPath = path.join(repoRoot, 'docs', 'API.md')

    const dtsSource = fs.readFileSync(dtsPath, 'utf8')
    apiMdSource = fs.readFileSync(apiMdPath, 'utf8')

    dtsPluginKeys = extractPluginsInterfaceKeys(dtsSource)
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

  it('should include all canonical plugin ids used by the runtime plugin registry in index.d.ts', () => {
    const pluginsIndexPath = path.join(packagesDir, 'dd-trace', 'src', 'plugins', 'index.js')

    const pluginsIndexSource = fs.readFileSync(pluginsIndexPath, 'utf8')

    const runtimePluginPackages = extractRuntimePluginPackageNames(pluginsIndexSource)

    // Runtime may load internal plugins that are not meant to be configured via the public API.
    const internalPluginIds = new Set([
      'dd-trace-api',
    ])

    for (const pkgName of runtimePluginPackages) {
      const pluginPath = path.join(packagesDir, pkgName, 'src', 'index.js')
      const Plugin = require(pluginPath)
      const id = Plugin?.id

      assert.ok(typeof id === 'string' && id.length > 0, `Invalid plugin id: ${pkgName}`)

      if (!internalPluginIds.has(id)) {
        assert.ok(dtsPluginKeys.has(id), `Missing plugin in index.d.ts: ${id}`)
      }
    }
  })

  it('should keep docs/API.md plugin list aligned with index.d.ts', () => {
    const apiPluginKeys = extractDocsApiPluginList(apiMdSource)

    for (const pluginId of dtsPluginKeys) {
      assert.ok(apiPluginKeys.has(pluginId), `Missing plugin in docs/API.md: ${pluginId}`)
    }

    for (const pluginId of apiPluginKeys) {
      assert.ok(dtsPluginKeys.has(pluginId), `Extra plugin in docs/API.md: ${pluginId}`)
    }
  })

  it('should keep docs/API.md <h5> plugin anchors aligned with index.d.ts', () => {
    const apiH5PluginKeys = extractDocsApiH5PluginAnchors(apiMdSource)

    for (const pluginId of dtsPluginKeys) {
      assert.ok(apiH5PluginKeys.has(pluginId), `Missing <h5> anchor in docs/API.md for plugin: ${pluginId}`)
    }

    for (const pluginId of apiH5PluginKeys) {
      assert.ok(dtsPluginKeys.has(pluginId), `Extra <h5> anchor in docs/API.md for plugin: ${pluginId}`)
    }
  })
})
