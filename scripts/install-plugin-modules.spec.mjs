import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it } from 'mocha'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { getAllInstrumentations, getInstrumentation, getInstrumentationNames } = require(
  '../packages/dd-trace/test/setup/helpers/load-inst'
)
const { getHooks } = require('../packages/datadog-instrumentations/src/helpers/instrument')

const pureIntegrations = {
  'azure-cosmos': '@azure/cosmos',
  bullmq: 'bullmq',
  langchain: '@langchain/core',
  langgraph: '@langchain/langgraph',
  mercurius: 'mercurius',
}

const subscriberOnlyIntegrations = {
  'claude-agent-sdk': ['@anthropic-ai/claude-agent-sdk'],
  'aws-durable-execution-sdk-js': ['@aws/durable-execution-sdk-js'],
  webdriverio: ['@wdio/cli', '@wdio/local-runner', '@wdio/jasmine-framework', 'webdriverio', '@wdio/utils'],
}

// Rewrite targets of an entry that narrows activation. They are internal files of the WebdriverIO project,
// reached through the packages above, and are never installed as fixtures on their own.
const rewriteOnlyModules = {
  webdriverio: ['@wdio/config', '@wdio/runner', 'webdriver', 'jasmine-core'],
}

describe('plugin fixture discovery', () => {
  it('discovers declarations for hookless rewriter integrations', () => {
    const all = getAllInstrumentations()

    for (const [plugin, moduleName] of Object.entries(pureIntegrations)) {
      const declarations = getInstrumentation(plugin)
      assert.ok(declarations.length > 0, `${plugin} should have declarations`)
      assert.deepEqual([...new Set(declarations.map(declaration => declaration.name))], [moduleName])
      assert.deepEqual(all[plugin], declarations)
    }
  })

  it('prefers real hybrid instrumentation modules over rewriter metadata', () => {
    const declarations = getInstrumentation('graphql')
    for (const file of ['language/printer.js', 'language/visitor.js', 'utilities/index.js']) {
      assert.deepEqual(declarations.find(declaration => declaration.file === file), {
        name: 'graphql',
        file,
        versions: ['>=0.10'],
      })
    }
  })

  it('uses exact rewriter declarations for subscriber-only runtime setup', () => {
    for (const [plugin, names] of Object.entries(subscriberOnlyIntegrations)) {
      const expected = [...getHooks(names).values()]
      assert.ok(expected.length > 0, `${plugin} should have rewriter declarations`)
      assert.deepEqual(getInstrumentation(plugin), expected)
    }
  })

  it('leaves rewrite-only packages of a narrowed entry out of fixture discovery', () => {
    for (const [plugin, names] of Object.entries(rewriteOnlyModules)) {
      const discovered = new Set(getInstrumentation(plugin).map(declaration => declaration.name))
      assert.ok(getHooks(names).size > 0, `${plugin} should rewrite ${names.join(', ')}`)
      for (const name of names) {
        assert.equal(discovered.has(name), false, `${name} should not be a ${plugin} fixture`)
      }
    }
  })

  it('discovers each integration once without treating the rewriter registry as an integration', () => {
    const names = getInstrumentationNames()
    assert.equal(names.filter(name => name === 'claude-agent-sdk').length, 1)
    assert.equal(names.includes('index'), false)
  })

  it('preserves missing-module errors for unknown integrations', () => {
    assert.throws(() => getInstrumentation('not-an-integration'), {
      code: 'MODULE_NOT_FOUND',
    })
  })

  it('does not replace a real instrumentation load error with rewriter metadata', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'dd-trace-load-inst-'))
    try {
      const helperPath = join(fixtureRoot, 'packages/dd-trace/test/setup/helpers')
      const instrumentationPath = join(fixtureRoot, 'packages/datadog-instrumentations/src')
      mkdirSync(helperPath, { recursive: true })
      mkdirSync(join(instrumentationPath, 'helpers/rewriter/instrumentations'), { recursive: true })
      copyFileSync(
        join(root, 'packages/dd-trace/test/setup/helpers/load-inst.js'),
        join(helperPath, 'load-inst.js')
      )
      writeFileSync(join(instrumentationPath, 'broken.js'), "throw new Error('real instrumentation failed')\n")
      writeFileSync(join(instrumentationPath, 'helpers/instrument.js'), 'exports.addHook = () => {}\n')
      writeFileSync(
        join(instrumentationPath, 'helpers/rewriter/instrumentations/broken.js'),
        "module.exports = [{ module: { name: 'rewriter', versionRange: '1', filePath: 'index.js' } }]\n"
      )

      const isolated = require(join(helperPath, 'load-inst.js'))
      assert.throws(() => isolated.getInstrumentation('broken'), /real instrumentation failed/)
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('selects BullMQ and its Redis external through the installer entrypoint', () => {
    withInstallerFixture({ PLUGINS: 'bullmq', PACKAGE_VERSION_RANGE: '5.66.0' }, fixtureRoot => {
      const workspace = JSON.parse(readFileSync(join(fixtureRoot, 'versions', 'package.json'), 'utf8'))
      assert.ok(workspace.workspaces.packages.includes('bullmq@5.66.0'))
      assert.ok(workspace.workspaces.packages.includes('redis'))
      const redis = JSON.parse(readFileSync(join(fixtureRoot, 'versions', 'redis', 'package.json'), 'utf8'))
      assert.match(redis.dependencies.redis, /^>=4/)
    })
  })

  it('applies PACKAGE_VERSION_RANGE to the Supabase client external through the installer entrypoint', () => {
    withInstallerFixture({ PLUGINS: 'supabase', PACKAGE_VERSION_RANGE: '2.115.0' }, fixtureRoot => {
      const { packages } = JSON.parse(readFileSync(join(fixtureRoot, 'versions', 'package.json'), 'utf8')).workspaces
      assert.ok(packages.includes('@supabase/supabase-js@2.115.0'))
      assert.ok(!packages.includes('@supabase/supabase-js@2.112.2'))
    })
  })

  it('installs native Express boundaries for an isolated PostgreSQL integration', () => {
    withInstallerFixture({ PLUGINS: 'pg' }, fixtureRoot => {
      const { packages } = JSON.parse(readFileSync(join(fixtureRoot, 'versions/package.json'), 'utf8')).workspaces
      assert.ok(packages.includes('express@4.3.0'))
      assert.ok(packages.includes('express@5.0.0'))
    })
  })

  it('injects LangGraph peers into its scoped workspace', () => {
    withInstallerFixture({ PLUGINS: 'langgraph', PACKAGE_VERSION_RANGE: '1.1.2' }, fixtureRoot => {
      const manifest = JSON.parse(readFileSync(
        join(fixtureRoot, 'versions/@langchain/langgraph@1.1.2/package.json'), 'utf8'
      ))
      assert.deepEqual(manifest.dependencies, {
        '@langchain/langgraph': '1.1.2',
        '@langchain/core': '^1.0.1',
        zod: '^3.25.32',
        'zod-to-json-schema': '^3.22.4',
      })
    }, {
      '@langchain/langgraph': {
        name: '@langchain/langgraph',
        version: '1.1.2',
        peerDependencies: {
          '@langchain/core': '^1.0.1',
          zod: '^3.25.32 || ^4.2.0',
          'zod-to-json-schema': '^3.x',
        },
        devDependencies: { 'zod-to-json-schema': '^3.22.4' },
      },
    })
  })

  it('preserves the Mongo sanitizer Express cap while sharing native declarations', () => {
    withInstallerFixture({ PLUGINS: 'express-mongo-sanitize' }, fixtureRoot => {
      const { packages } = JSON.parse(readFileSync(join(fixtureRoot, 'versions/package.json'), 'utf8')).workspaces
      assert.ok(packages.includes('express@4.3.0'))
      assert.equal(packages.some(name => /^express@5(?:\.|$)/.test(name)), false)
    })
  })

  it('preserves the Apollo server Fastify floor while sharing native declarations', () => {
    withInstallerFixture({ PLUGINS: 'apollo-server-core' }, fixtureRoot => {
      const { packages } = JSON.parse(readFileSync(join(fixtureRoot, 'versions/package.json'), 'utf8')).workspaces
      assert.equal(packages.some(name => /^fastify@[12](?:\.|$)/.test(name)), false)
      assert.ok(packages.includes('fastify@3.0.0'))
    })
  })

  it('prefers published peer ranges and resolves workspace-only development dependencies', () => {
    withInstallerFixture({ PLUGINS: 'langchain' }, fixtureRoot => {
      const manifest = JSON.parse(readFileSync(
        join(fixtureRoot, 'versions/@langchain/google-genai@0.1.0/package.json'), 'utf8'
      ))
      assert.equal(manifest.dependencies['@langchain/core'], '>=0.2.21 <0.4.0')
      const cohere = JSON.parse(readFileSync(
        join(fixtureRoot, 'versions/@langchain/cohere@0.1.0/package.json'), 'utf8'
      ))
      const latests = require('../packages/dd-trace/test/plugins/versions/package.json').dependencies
      assert.equal(cohere.dependencies['@langchain/core'], latests['@langchain/core'])
    }, {
      langchain: { name: 'langchain', version: '1.0.0' },
      '@langchain/anthropic': { name: '@langchain/anthropic', version: '1.0.0' },
      '@langchain/cohere': {
        name: '@langchain/cohere',
        version: '0.1.0',
        devDependencies: { '@langchain/core': 'workspace:*' },
      },
      '@langchain/google-genai': {
        name: '@langchain/google-genai',
        version: '0.1.0',
        devDependencies: { '@langchain/core': 'workspace:*' },
        peerDependencies: { '@langchain/core': '>=0.2.21 <0.4.0' },
      },
    })
  })
})

/**
 * Run the real installer entrypoint against a throwaway `versions/` tree with `yarn` stubbed out.
 *
 * @param {Record<string, string>} env
 * @param {(fixtureRoot: string) => void} assertions
 * @param {Record<string, object>} manifests
 */
function withInstallerFixture (env, assertions, manifests = {}) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'dd-trace-plugin-installer-'))
  try {
    const scripts = join(fixtureRoot, 'scripts')
    mkdirSync(scripts)
    symlinkSync(join(root, 'packages'), join(fixtureRoot, 'packages'), 'junction')
    symlinkSync(join(root, 'node_modules'), join(fixtureRoot, 'node_modules'), 'junction')
    symlinkSync(join(root, 'scripts', 'helpers'), join(scripts, 'helpers'), 'junction')
    copyFileSync(join(root, 'scripts', 'install_plugin_modules.js'), join(scripts, 'install_plugin_modules.js'))

    const preload = join(fixtureRoot, 'preload.cjs')
    writeFileSync(preload, `
const fs = require('node:fs')
const path = require('node:path')
const execPath = require.resolve(process.env.DD_INSTALLER_EXEC_PATH)
require.cache[execPath] = {
  exports (command, options) {
    for (const [name, manifest] of Object.entries(JSON.parse(process.env.DD_INSTALLER_MANIFESTS))) {
      const packagePath = path.join(options.cwd, 'node_modules', name)
      fs.mkdirSync(packagePath, { recursive: true })
      fs.writeFileSync(path.join(packagePath, 'package.json'), JSON.stringify(manifest))
    }
  },
}
`)

    execFileSync(process.execPath, ['--require', preload, join(scripts, 'install_plugin_modules.js')], {
      env: {
        ...process.env,
        DD_INSTALLER_EXEC_PATH: join(root, 'scripts/helpers/exec.js'),
        DD_INSTALLER_MANIFESTS: JSON.stringify({ bullmq: { name: 'bullmq', version: '5.66.0' }, ...manifests }),
        ...env,
      },
      stdio: 'pipe',
    })

    assertions(fixtureRoot)
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
}
