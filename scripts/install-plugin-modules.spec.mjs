import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it } from 'mocha'
import { satisfies } from 'semver'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { getAllInstrumentations, getInstrumentation, getInstrumentationNames } = require(
  '../packages/dd-trace/test/setup/helpers/load-inst'
)
const { getCappedRange } = require('../packages/dd-trace/test/plugins/versions')

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
    withInstallerFixture({ PLUGINS: 'bullmq', PACKAGE_VERSION_RANGE: '5.66.0' }, fixtureRoot => {
      const workspace = JSON.parse(readFileSync(join(fixtureRoot, 'versions', 'package.json')))
      assert.ok(workspace.workspaces.packages.includes('bullmq@5.66.0'))
      assert.ok(workspace.workspaces.packages.includes('redis'))
      const redis = JSON.parse(readFileSync(join(fixtureRoot, 'versions', 'redis', 'package.json')))
      assert.match(redis.dependencies.redis, /^>=4/)
    })
  })

  it('applies PACKAGE_VERSION_RANGE to the Supabase client external through the installer entrypoint', () => {
    withInstallerFixture({ PLUGINS: 'supabase', PACKAGE_VERSION_RANGE: '2.115.0' }, fixtureRoot => {
      const { packages } = JSON.parse(readFileSync(join(fixtureRoot, 'versions', 'package.json'))).workspaces
      assert.ok(packages.includes('@supabase/supabase-js@2.115.0'))
      assert.ok(!packages.includes('@supabase/supabase-js@2.112.2'))
    })
  })

  for (const packageVersionRange of ['', '16.14.2']) {
    const selection = packageVersionRange ? 'a sharded GraphQL version' : 'GraphQL'
    it(`installs isolated graphql-jit layouts and compatible peers with ${selection}`, () => {
      withInstallerFixture({
        PLUGINS: 'graphql',
        PACKAGE_VERSION_RANGE: packageVersionRange,
        RANGE: '',
      }, fixtureRoot => {
        const { packages } = JSON.parse(readFileSync(join(fixtureRoot, 'versions', 'package.json'))).workspaces
        const jitWorkspaces = packages.filter(name => name === 'graphql-jit' || name.startsWith('graphql-jit@'))
        const floors = ['0.7.0', '0.8.0', '0.8.5', '0.8.7']
        const ranges = [
          '>=0.7.0 <0.8.5 || >=0.8.7 <0.9.0',
          '>=0.8.0 <0.8.5',
          '>=0.8.5 <0.8.7',
          '>=0.8.7 <0.9.0',
        ]
        assert.deepEqual(jitWorkspaces, [
          'graphql-jit',
          ...[...floors, ...ranges].map(version => `graphql-jit@${version}`),
        ].sort())

        for (const name of jitWorkspaces) {
          const manifest = JSON.parse(readFileSync(join(fixtureRoot, 'versions', name, 'package.json')))
          assert.deepEqual(manifest.workspaces?.nohoist, ['**/**'], `${name} should be isolated`)
          assert.equal(manifest.dependencies.graphql, '^16.0.0', `${name} should use its declared GraphQL peer`)

          if (name === 'graphql-jit') {
            for (const version of [...floors, '0.8.4', '0.8.6']) {
              assert.ok(satisfies(version, manifest.dependencies['graphql-jit']), `${name} should support ${version}`)
            }
            for (const version of ['0.6.9', '0.9.0']) {
              assert.ok(!satisfies(version, manifest.dependencies['graphql-jit']), `${name} should exclude ${version}`)
            }
          } else {
            const versionKey = name.slice('graphql-jit@'.length)
            assert.equal(manifest.dependencies['graphql-jit'], getCappedRange('graphql-jit', versionKey))
          }
        }

        const yogaWorkspaces = packages.filter(name => name === 'graphql-yoga' || name.startsWith('graphql-yoga@'))
        assert.ok(yogaWorkspaces.length > 0, 'ordinary GraphQL externals should still be installed')
        for (const name of yogaWorkspaces) {
          const manifest = JSON.parse(readFileSync(join(fixtureRoot, 'versions', name, 'package.json')))
          assert.equal(manifest.workspaces?.nohoist, undefined, `${name} should remain hoistable`)
        }

        if (packageVersionRange) {
          assert.deepEqual(packages.filter(name => name === 'graphql' || name.startsWith('graphql@')), [
            'graphql',
            'graphql@16.14.2',
          ])
        }
      })
    })
  }
})

/**
 * Run the real installer entrypoint against a throwaway `versions/` tree with `yarn` stubbed out.
 *
 * @param {Record<string, string>} env
 * @param {(fixtureRoot: string) => void} assertions
 */
function withInstallerFixture (env, assertions) {
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
    if (process.env.PLUGINS === 'graphql') {
      const jitPath = path.join(options.cwd, 'node_modules/graphql-jit')
      fs.mkdirSync(jitPath, { recursive: true })
      fs.writeFileSync(path.join(jitPath, 'package.json'), JSON.stringify({
        name: 'graphql-jit',
        version: '0.8.9',
        peerDependencies: { graphql: '^16.0.0' },
      }) + '\n')
    }
  },
}
`)

    execFileSync(process.execPath, ['--require', preload, join(scripts, 'install_plugin_modules.js')], {
      env: {
        ...process.env,
        DD_INSTALLER_EXEC_PATH: join(root, 'scripts/helpers/exec.js'),
        ...env,
      },
      stdio: 'pipe',
    })

    assertions(fixtureRoot)
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
}
