'use strict'

// Temporary experiment: times and CPU-profiles Cypress runs on this job's Node version. Not meant to be merged.

const { exec } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')

const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
  warmCypressBinary,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { startWebAppServer, stopWebAppServer } = require('../ci-visibility/web-app-server')
const { getCypressDependencies } = require('./dependencies')

const version = process.env.CYPRESS_VERSION || '14.5.4'
const profileRoot = process.env.CYPRESS_PROFILE_DIR || path.join(process.cwd(), 'cypress-profiles')
const repetitions = Number(process.env.CYPRESS_PROFILE_REPETITIONS || 5)
const spec = 'cypress/e2e/profile-plain.js'

/**
 * @param {number[]} values
 */
function median (values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/**
 * @param {{ url: string, functionName: string }} frame
 */
function packageOf ({ url, functionName }) {
  if (!url) return /^\(/.test(functionName) ? functionName : '(native)'
  if (url.startsWith('node:')) return 'node:internal'
  const app = url.match(/Cypress\/resources\/app\/(?:node_modules\/)?((?:@[^/]+\/)?[^/]+)/)
  if (app) return `cypress-app:${app[1]}`
  const modules = url.split('node_modules/')
  if (modules.length > 1) {
    const rest = modules[modules.length - 1].split('/')
    const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0]
    if (name === 'dd-trace') return `dd-trace:${rest.slice(1, 3).join('/')}`
    return name
  }
  return url.replace(/^file:\/\//, '').split('/').slice(-2).join('/')
}

/**
 * @param {string} file
 */
function summarizeProfile (file) {
  const profile = JSON.parse(fs.readFileSync(file, 'utf8'))
  const nodes = new Map(profile.nodes.map(node => [node.id, node]))
  const parents = new Map()
  for (const node of profile.nodes) for (const child of node.children || []) parents.set(child, node.id)
  const selfTime = new Map()
  for (let i = 0; i < profile.samples.length; i++) {
    selfTime.set(profile.samples[i], (selfTime.get(profile.samples[i]) || 0) + profile.timeDeltas[i])
  }
  const byPackage = new Map()
  const inclusive = new Map()
  for (const [id, time] of selfTime) {
    const node = nodes.get(id)
    const pkg = packageOf(node.callFrame)
    byPackage.set(pkg, (byPackage.get(pkg) || 0) + time)
    const seen = new Set()
    for (let current = id; current !== undefined; current = parents.get(current)) {
      const frame = nodes.get(current).callFrame
      const location = `${frame.url.split('/').pop()}:${frame.lineNumber}`
      const key = `${frame.functionName || '(anonymous)'} ${packageOf(frame)} ${location}`
      if (seen.has(key)) continue
      seen.add(key)
      inclusive.set(key, (inclusive.get(key) || 0) + time)
    }
  }
  const urls = profile.nodes.map(node => node.callFrame.url)
  const role = urls.some(url => url.includes('datadog-plugin-cypress/src/cypress-plugin'))
    ? 'config process'
    : urls.some(url => url.includes('cypress/lib/cli') || url.includes('cypress/lib/exec'))
      ? 'cypress CLI'
      : 'other'
  const ms = value => (value / 1000).toFixed(0).padStart(6)
  const lines = [`--- ${path.basename(file)} (${role}) total ${ms(profile.endTime - profile.startTime)}ms`]
  lines.push('  self time by package:')
  for (const [pkg, time] of [...byPackage].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    lines.push(`  ${ms(time)}ms ${pkg}`)
  }
  lines.push('  inclusive time (top frames, excluding root/module loader plumbing):')
  const plumbing = /^\(root\)|^\(program\)|^\(idle\)|node:internal|wrapModuleLoad|Module\._load|^require /
  for (const [key, time] of [...inclusive].sort((a, b) => b[1] - a[1]).filter(([key]) => !plumbing.test(key))
    .slice(0, 30)) {
    lines.push(`  ${ms(time)}ms ${key}`)
  }
  return lines.join('\n')
}

describe(`cypress@${version} profile experiment on node ${process.version}`, function () {
  this.timeout(900_000)
  let cwd, webApp

  useSandbox(getCypressDependencies(version), true)

  before(async function () {
    this.timeout(300_000)
    cwd = sandboxCwd()
    await warmCypressBinary(cwd)
    webApp = await startWebAppServer()
    fs.writeFileSync(path.join(cwd, spec), [
      "describe('plain', () => {",
      "  it('passes', () => {",
      "    cy.visit('/')",
      "    cy.get('.hello-world').should('have.text', 'Hello World')",
      '  })',
      '})',
      '',
    ].join('\n'))
  })

  after(async () => {
    await stopWebAppServer(webApp.server)
  })

  /**
   * @param {{ traced: boolean, profileDir?: string }} options
   */
  async function runCypress ({ traced, profileDir }) {
    const receiver = await new FakeCiVisIntake().start()
    receiver.setSettings({ itr_enabled: false, code_coverage: false, tests_skipping: false })
    const env = {
      ...getCiVisAgentlessConfig(receiver.port),
      CYPRESS_BASE_URL: webApp.baseUrl,
      SPEC_PATTERN: spec,
    }
    delete env.CYPRESS_VERSION
    if (!traced) env.NODE_OPTIONS = ''
    if (profileDir) env.NODE_OPTIONS = `${env.NODE_OPTIONS} --cpu-prof --cpu-prof-dir=${profileDir}`.trim()
    const start = performance.now()
    const marks = {}
    const child = exec('./node_modules/.bin/cypress run --config supportFile=false', { cwd, env })
    let output = ''
    const onData = chunk => {
      output += chunk
      const now = performance.now() - start
      if (marks.banner === undefined && /Cypress:\s+\d/.test(output)) marks.banner = now
      if (marks.firstResult === undefined && /✓|passing/.test(output)) marks.firstResult = now
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const [code] = await once(child, 'exit')
    marks.exit = performance.now() - start
    await receiver.stop()
    if (code !== 0) throw new Error(`cypress exited with ${code}:\n${output}`)
    return marks
  }

  it('times traced and untraced runs', async () => {
    const results = { traced: [], untraced: [] }
    for (let i = 0; i < repetitions; i++) {
      results.traced.push(await runCypress({ traced: true }))
      results.untraced.push(await runCypress({ traced: false }))
    }
    // eslint-disable-next-line no-console
    console.log(`\nPROFILE_EXPERIMENT timings on node ${process.version}, cypress ${version}, median of ${repetitions}`)
    for (const [variant, runs] of Object.entries(results)) {
      const banner = median(runs.map(run => run.banner))
      const firstResult = median(runs.map(run => run.firstResult))
      const exit = median(runs.map(run => run.exit))
      // eslint-disable-next-line no-console
      console.log(`PROFILE_EXPERIMENT ${variant.padEnd(8)} start->banner ${banner.toFixed(0)}ms ` +
        `banner->first result ${(firstResult - banner).toFixed(0)}ms ` +
        `first result->exit ${(exit - firstResult).toFixed(0)}ms total ${exit.toFixed(0)}ms`)
    }
  })

  for (const traced of [true, false]) {
    it(`profiles a ${traced ? 'traced' : 'untraced'} run`, async () => {
      const profileDir = path.join(profileRoot, `node-${process.versions.node}-${traced ? 'traced' : 'untraced'}`)
      fs.rmSync(profileDir, { force: true, recursive: true })
      fs.mkdirSync(profileDir, { recursive: true })
      const marks = await runCypress({ traced, profileDir })
      const summaries = fs.readdirSync(profileDir).filter(file => file.endsWith('.cpuprofile'))
        .map(file => summarizeProfile(path.join(profileDir, file)))
      // eslint-disable-next-line no-console
      console.log(`\nPROFILE_EXPERIMENT profiled ${traced ? 'traced' : 'untraced'} run on node ${process.version}: ` +
        `banner ${marks.banner.toFixed(0)}ms total ${marks.exit.toFixed(0)}ms\n${summaries.join('\n')}`)
    })
  }
})
