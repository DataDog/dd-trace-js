'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')

// This process deliberately simulates a supported Node.js version before getBuiltinModule was added.
// eslint-disable-next-line n/no-unsupported-features/node-builtins
const originalGetBuiltinModule = process.getBuiltinModule
if (originalGetBuiltinModule) {
  // eslint-disable-next-line n/no-unsupported-features/node-builtins
  process.getBuiltinModule = name => {
    const builtin = originalGetBuiltinModule(name)
    if (name !== 'module') return builtin
    return new Proxy(builtin, {
      get: (target, property, receiver) => property === 'stripTypeScriptTypes'
        ? undefined
        : Reflect.get(target, property, receiver),
    })
  }
}

const {
  applyDatadogTurbopack,
  cleanup,
  createPackage,
  createProject,
  findDatadogLoaders,
  write,
} = require('../helpers')

async function main () {
  const projectDir = createProject()
  try {
    const packageDir = createPackage(projectDir, 'ai', {
      exports: './index.mts',
      type: 'module',
      version: '7.0.0',
    })
    const targetPath = write(packageDir, 'index.mts', [
      'export abstract class Client {',
      '  abstract run (): void',
      '}',
      '',
    ].join('\n'))
    const config = await applyDatadogTurbopack({}, { projectDir })
    const manifestPath = findDatadogLoaders(config)[0].options.manifestPath
    const plan = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const target = plan.targets[fs.realpathSync(targetPath).replaceAll('\\', '/')]
    const proxy = fs.readFileSync(target.proxyPath, 'utf8')

    assert.match(proxy, /"Client"/)
  } finally {
    cleanup()
  }
}

main()
