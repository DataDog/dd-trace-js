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

const pureIntegrations = {
  'azure-cosmos': '@azure/cosmos',
  bullmq: 'bullmq',
  langchain: '@langchain/core',
  langgraph: '@langchain/langgraph',
  mercurius: 'mercurius',
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
    const declarations = getInstrumentation('claude-agent-sdk')
    assert.ok(declarations.length > 0)
    assert.ok(declarations.every(declaration => declaration.file === null))
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
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'dd-trace-plugin-installer-'))
    try {
      const scripts = join(fixtureRoot, 'scripts')
      mkdirSync(scripts)
      symlinkSync(join(root, 'packages'), join(fixtureRoot, 'packages'), 'junction')
      symlinkSync(join(root, 'node_modules'), join(fixtureRoot, 'node_modules'), 'junction')
      symlinkSync(join(root, 'scripts', 'helpers'), join(scripts, 'helpers'), 'junction')
      copyFileSync(join(root, 'scripts', 'install_plugin_modules.js'), join(scripts, 'install_plugin_modules.js'))

      const preload = join(fixtureRoot, 'preload.cjs')
      writeFileSync(preload, String.raw`
const fs = require('node:fs')
const path = require('node:path')
const execPath = require.resolve(process.env.DD_INSTALLER_EXEC_PATH)
require.cache[execPath] = {
  exports (command, options) {
    const packagePath = path.join(options.cwd, 'node_modules/bullmq')
    fs.mkdirSync(packagePath, { recursive: true })
    fs.writeFileSync(path.join(packagePath, 'package.json'), '{"name":"bullmq","version":"5.66.0"}\n')
  },
}
`)

      execFileSync(process.execPath, ['--require', preload, join(scripts, 'install_plugin_modules.js')], {
        env: {
          ...process.env,
          DD_INSTALLER_EXEC_PATH: join(root, 'scripts/helpers/exec.js'),
          PLUGINS: 'bullmq',
          PACKAGE_VERSION_RANGE: '5.66.0',
        },
        stdio: 'pipe',
      })

      const workspace = JSON.parse(readFileSync(join(fixtureRoot, 'versions', 'package.json')))
      assert.ok(workspace.workspaces.packages.includes('bullmq@5.66.0'))
      assert.ok(workspace.workspaces.packages.includes('redis'))
      const redis = JSON.parse(readFileSync(join(fixtureRoot, 'versions', 'redis', 'package.json')))
      assert.match(redis.dependencies.redis, /^>=4/)
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })
})
