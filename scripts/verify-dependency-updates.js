'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const path = require('node:path')

const yaml = require('yaml')

const { updates } = yaml.parse(readFileSync('.github/dependabot.yml', 'utf8'))
const renovate = JSON.parse(readFileSync('.github/renovate.json', 'utf8'))
const directories = new Map()
for (const update of updates) {
  const ecosystem = update['package-ecosystem']
  if (ecosystem !== 'bun' && ecosystem !== 'npm') continue
  for (const directory of update.directories ?? [update.directory]) {
    assert.ok(!directories.has(directory), `Duplicate Dependabot directory: ${directory}`)
    directories.set(directory, ecosystem)
  }
}

const files = execFileSync('git', ['ls-files', '--deduplicate', '-z'], { encoding: 'utf8' }).split('\0')
const locks = new Set(['bun.lock', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'])
for (const file of files) {
  if (file.includes('/node_modules/')) continue
  const basename = path.posix.basename(file)
  if (basename !== 'package.json' && !locks.has(basename)) continue
  if (basename === 'package.json') {
    const manifest = JSON.parse(readFileSync(file, 'utf8'))
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    }
    if (!Object.values(dependencies).some(version => !/^(?:file:|link:|workspace:)/.test(version))) continue
  }

  const parent = path.posix.dirname(file)
  const directory = parent === '.' ? '/' : `/${parent}`
  const ecosystem = directories.get(directory)
  assert.ok(ecosystem, `Dependabot does not cover ${file}`)
  if (locks.has(basename)) {
    assert.strictEqual(ecosystem, basename === 'bun.lock' ? 'bun' : 'npm',
      `Dependabot uses the wrong ecosystem for ${file}`)
  }
  assert.ok(renovate.enabledManagers.includes(ecosystem), `Renovate does not enable ${ecosystem} for ${file}`)
  assert.ok(renovate.includePaths.includes(file), `Renovate does not cover ${file}`)
}

for (const directory of directories.keys()) {
  const manifest = directory === '/' ? 'package.json' : `${directory.slice(1)}/package.json`
  assert.ok(files.includes(manifest), `Dependabot directory has no tracked manifest: ${directory}`)
  assert.ok(renovate.includePaths.includes(manifest), `Renovate does not cover ${manifest}`)
}
