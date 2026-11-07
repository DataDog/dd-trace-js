'use strict'

const assert = require('node:assert/strict')
const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')

const script = path.resolve(__dirname, '../verify-dependency-updates.js')

describe('dependency updater coverage', () => {
  let directory, dependabot, renovate

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(tmpdir(), 'dd-dependency-updates-'))
    fs.mkdirSync(path.join(directory, '.github'))
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ dependencies: { example: '1.0.0' } }))
    fs.writeFileSync(path.join(directory, 'bun.lock'), '{}')
    dependabot = { updates: [{ 'package-ecosystem': 'bun', directory: '/' }] }
    renovate = { enabledManagers: ['bun'], includePaths: ['package.json', 'bun.lock'] }
    execFileSync('git', ['init', '--quiet'], { cwd: directory })
    execFileSync('git', ['add', '.'], { cwd: directory })
  })

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))

  function verify () {
    fs.writeFileSync(path.join(directory, '.github/dependabot.yml'), JSON.stringify(dependabot))
    fs.writeFileSync(path.join(directory, '.github/renovate.json'), JSON.stringify(renovate))
    return spawnSync(process.execPath, [script], { cwd: directory, encoding: 'utf8' })
  }

  it('accepts matching updater coverage', () => {
    const result = verify()
    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('rejects an uncovered manifest', () => {
    dependabot.updates = []
    const result = verify()
    assert.notStrictEqual(result.status, 0)
    assert.match(result.stderr, /Dependabot does not cover/)
  })

  it('rejects an uncovered lockfile', () => {
    renovate.includePaths = ['package.json']
    const result = verify()
    assert.notStrictEqual(result.status, 0)
    assert.match(result.stderr, /Renovate does not cover bun.lock/)
  })

  it('rejects an updater that cannot read the lockfile', () => {
    dependabot.updates[0]['package-ecosystem'] = 'npm'
    const result = verify()
    assert.notStrictEqual(result.status, 0)
    assert.match(result.stderr, /wrong ecosystem/)
  })

  it('ignores manifests that only refer to local packages', () => {
    fs.mkdirSync(path.join(directory, 'fixture'))
    fs.writeFileSync(path.join(directory, 'fixture/package.json'), JSON.stringify({
      dependencies: { local: 'file:..' },
    }))
    execFileSync('git', ['add', 'fixture'], { cwd: directory })
    const result = verify()
    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('rejects duplicate Dependabot directories', () => {
    dependabot.updates.push(dependabot.updates[0])
    const result = verify()
    assert.notStrictEqual(result.status, 0)
    assert.match(result.stderr, /Duplicate Dependabot directory/)
  })

  it('rejects missing Renovate managers', () => {
    renovate.enabledManagers = []
    const result = verify()
    assert.notStrictEqual(result.status, 0)
    assert.match(result.stderr, /Renovate does not enable bun/)
  })

  it('rejects removed dependency directories', () => {
    dependabot.updates.push({ 'package-ecosystem': 'bun', directory: '/removed' })
    const result = verify()
    assert.notStrictEqual(result.status, 0)
    assert.match(result.stderr, /no tracked manifest/)
  })

  it('covers nested npm projects without updating mock installed packages', () => {
    fs.mkdirSync(path.join(directory, 'fixture/node_modules/mock'), { recursive: true })
    const manifest = JSON.stringify({ dependencies: { example: '1.0.0' } })
    fs.writeFileSync(path.join(directory, 'fixture/package.json'), manifest)
    fs.writeFileSync(path.join(directory, 'fixture/package-lock.json'), '{}')
    fs.writeFileSync(path.join(directory, 'fixture/node_modules/mock/package.json'), manifest)
    execFileSync('git', ['add', 'fixture'], { cwd: directory })
    dependabot.updates.push({ 'package-ecosystem': 'npm', directory: '/fixture' })
    renovate.enabledManagers.push('npm')
    renovate.includePaths.push('fixture/package.json', 'fixture/package-lock.json')
    const result = verify()
    assert.strictEqual(result.status, 0, result.stderr)
  })
})
