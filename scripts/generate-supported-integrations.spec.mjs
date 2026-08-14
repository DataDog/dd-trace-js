import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it } from 'mocha'
import sinon from 'sinon'
import YAML from 'yaml'

const require = createRequire(import.meta.url)
const repositoryDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const generatorPath = path.join(repositoryDirectory, 'scripts/generate-supported-integrations.js')
const {
  checkSupportedIntegrations,
  generateSupportedIntegrations,
  writeSupportedIntegrations,
} = require('./generate-supported-integrations')

const nodeAliases = {
  'node-18': 'npm:node@18.20.8',
  'node-20': 'npm:node@20.20.2',
  'node-22': 'npm:node@22.22.3',
  'node-24': 'npm:node@24.16.0',
  'node-26': 'npm:node@26.2.0',
  'node-28': 'npm:node@28.0.0',
}

describe('generate supported integrations', () => {
  it('intersects the release line and workflow Node.js ranges', async () => {
    const { rows } = await generateSupportedIntegrations({
      packageInfo: { engines: { node: '>=22' }, nodeMaxMajor: 27 },
      versions: nodeAliases,
      nodeRange: '>=24',
      plugins: new Map([['http', 'http']]),
      instrumentations: new Map([
        ['24.16.0', new Map()],
        ['26.2.0', new Map()],
      ]),
      getPackageVersions: () => Promise.reject(new Error('Node.js built-ins do not use npm metadata')),
    })

    assert.deepStrictEqual(rows, [{
      dependencyName: 'node:http',
      integrationName: 'http',
      autoInstrumented: true,
      versions: [{
        testedRuntimes: {
          node: ['26.2.0', '24.16.0'],
        },
        supportedRange: '*',
        tested: [],
      }],
    }])
  })

  it('uses every tested alias when the release line has no upper bound', async () => {
    const { rows } = await generateSupportedIntegrations({
      packageInfo: { engines: { node: '>=24' } },
      versions: nodeAliases,
      plugins: new Map([['http', 'http']]),
      instrumentations: new Map([
        ['24.16.0', new Map()],
        ['26.2.0', new Map()],
        ['28.0.0', new Map()],
      ]),
      getPackageVersions: () => Promise.reject(new Error('Node.js built-ins do not use npm metadata')),
    })

    assert.deepStrictEqual(rows[0].versions[0].testedRuntimes.node, ['28.0.0', '26.2.0', '24.16.0'])
  })

  it('uses the tested package versions active on each Node.js line', async () => {
    const { rows } = await generateSupportedIntegrations({
      nodeProfiles: [
        { key: '22', version: '22.22.3' },
        { key: '24', version: '24.16.0' },
      ],
      plugins: new Map([['express', 'express']]),
      instrumentations: new Map([
        ['22.22.3', new Map([['express', [{ versions: ['>=4 <5'] }]]])],
        ['24.16.0', new Map([['express', [{ versions: ['>=4 <6'], node: '>=24' }]]])],
      ]),
      getPackageVersions: dependency => {
        assert.strictEqual(dependency, 'express')
        return Promise.resolve(['4.0.0', '4.22.1', '5.2.1', '6.0.0'])
      },
    })

    assert.deepStrictEqual(rows, [{
      dependencyName: 'express',
      integrationName: 'express',
      autoInstrumented: true,
      versions: [{
        testedRuntimes: {
          node: ['24.16.0'],
        },
        supportedRange: '>=4 <6',
        tested: ['4.0.0', '4.22.1', '5.2.1'],
      }, {
        testedRuntimes: {
          node: ['22.22.3'],
        },
        supportedRange: '>=4 <5',
        tested: ['4.0.0', '4.22.1'],
      }],
    }])
  })

  it('keeps an open declared package range uncapped', async () => {
    const { rows } = await generateSupportedIntegrations({
      nodeProfiles: [
        { key: '24', version: '24.16.0' },
        { key: '26', version: '26.2.0' },
      ],
      plugins: new Map([['@azure/event-hubs', 'azure-event-hubs']]),
      instrumentations: new Map([
        ['24.16.0', new Map([['@azure/event-hubs', [{ versions: ['>=6.0.0'] }]]])],
        ['26.2.0', new Map([['@azure/event-hubs', [{ versions: ['>=6.0.0'] }]]])],
      ]),
      getPackageVersions: () => Promise.resolve(['6.0.0', '6.0.4']),
    })

    assert.deepStrictEqual(rows, [{
      dependencyName: '@azure/event-hubs',
      integrationName: 'azure-event-hubs',
      autoInstrumented: true,
      versions: [{
        testedRuntimes: {
          node: ['26.2.0', '24.16.0'],
        },
        supportedRange: '>=6.0.0',
        tested: ['6.0.0', '6.0.4'],
      }],
    }])
  })

  it('removes ranges covered by another active declaration', async () => {
    const { rows } = await generateSupportedIntegrations({
      nodeProfiles: [{ key: '24', version: '24.16.0' }],
      plugins: new Map([['express', 'express']]),
      instrumentations: new Map([
        ['24.16.0', new Map([['express', [
          { versions: ['>=4'] },
          { versions: ['4'] },
          { versions: ['>=4.0.0 <4.3.0'] },
          { versions: ['>=4.3.0 <5.0.0'] },
          { versions: ['>=5.0.0'] },
        ]]])],
      ]),
      getPackageVersions: () => Promise.resolve(['4.0.0', '4.2.0', '4.3.0', '4.22.1', '5.0.0', '5.2.1']),
    })

    assert.strictEqual(rows[0].versions[0].supportedRange, '>=4')
  })

  it('keeps the first of two equivalent active ranges', async () => {
    const { rows } = await generateSupportedIntegrations({
      nodeProfiles: [{ key: '24', version: '24.16.0' }],
      plugins: new Map([['express', 'express']]),
      instrumentations: new Map([
        ['24.16.0', new Map([['express', [
          { versions: ['4'] },
          { versions: ['>=4 <5'] },
        ]]])],
      ]),
      getPackageVersions: () => Promise.resolve(['4.0.0', '4.22.1']),
    })

    assert.strictEqual(rows[0].versions[0].supportedRange, '4')
  })

  it('omits dependencies without instrumentation on a tested runtime', async () => {
    const { rows } = await generateSupportedIntegrations({
      nodeProfiles: [{ key: '24', version: '24.16.0' }],
      plugins: new Map([['express', 'express']]),
      instrumentations: new Map([['24.16.0', new Map()]]),
      getPackageVersions: () => Promise.reject(new Error('Dependencies without hooks do not use npm metadata')),
    })

    assert.deepStrictEqual(rows, [])
  })

  it('omits Node.js lines outside an instrumentation declaration gate', async () => {
    const declarations = [{ versions: ['>=4 <5'], node: '>=24' }]
    const { rows } = await generateSupportedIntegrations({
      nodeProfiles: [
        { key: '22', version: '22.22.3' },
        { key: '24', version: '24.16.0' },
      ],
      plugins: new Map([['express', 'express']]),
      instrumentations: new Map([
        ['22.22.3', new Map([['express', declarations]])],
        ['24.16.0', new Map([['express', declarations]])],
      ]),
      getPackageVersions: () => Promise.resolve(['4.0.0', '4.22.1']),
    })

    assert.deepStrictEqual(rows[0].versions[0].testedRuntimes.node, ['24.16.0'])
  })

  it('reports npm metadata request failures', async () => {
    const fetch = sinon.stub(globalThis, 'fetch').resolves({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    })

    try {
      await assert.rejects(generateSupportedIntegrations({
        nodeProfiles: [{ key: '22', version: '22.22.3' }],
        plugins: new Map([['missing-package', 'missing-package']]),
        instrumentations: new Map([
          ['22.22.3', new Map([['missing-package', [{ versions: ['1.0.0'] }]]])],
        ]),
      }), /Could not read npm metadata for 'missing-package': 404 Not Found/)
    } finally {
      fetch.restore()
    }
  })

  it('reports a tested version missing from npm metadata', async () => {
    const fetch = sinon.stub(globalThis, 'fetch').resolves({
      ok: true,
      json: () => Promise.resolve({}),
    })

    try {
      await assert.rejects(generateSupportedIntegrations({
        nodeProfiles: [{ key: '22', version: '22.22.3' }],
        plugins: new Map([['express', 'express']]),
        instrumentations: new Map([
          ['22.22.3', new Map([['express', [{ versions: ['1.0.0'] }]]])],
        ]),
      }), /Could not resolve 'express@1\.0\.0' from npm metadata/)
    } finally {
      fetch.restore()
    }
  })

  it('rejects an invalid workflow Node.js range', async () => {
    await assert.rejects(generateSupportedIntegrations({
      packageInfo: { engines: { node: '>=22' }, nodeMaxMajor: 27 },
      versions: nodeAliases,
      nodeRange: 'invalid',
    }), /Invalid Node\.js version range: invalid/)
  })

  it('rejects a workflow Node.js range with no tested versions', async () => {
    await assert.rejects(generateSupportedIntegrations({
      packageInfo: { engines: { node: '>=22' }, nodeMaxMajor: 27 },
      versions: nodeAliases,
      nodeRange: '>=27 <28',
    }), /No tested Node\.js versions satisfy '>=22 <27' and '>=27 <28'/)
  })

  it('rejects a missing workflow Node.js range value from the CLI', () => {
    for (const args of [['--node-range'], ['--node-range', '--check']]) {
      const result = spawnSync(process.execPath, [generatorPath, ...args], { encoding: 'utf8' })

      assert.strictEqual(result.status, 1)
      assert.match(result.stderr, /--node-range requires a semver range/)
    }
  })

  it('writes and verifies only the JSON artifact', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'dd-supported-versions-'))
    const outputPath = path.join(directory, 'supported_versions.json')
    const options = {
      nodeProfiles: [{ key: '22', version: '22.22.3' }],
      plugins: new Map([['fs', 'fs']]),
      instrumentations: new Map([['22.22.3', new Map()]]),
      getPackageVersions: () => Promise.reject(new Error('Node.js built-ins do not use npm metadata')),
      outputPath,
    }

    try {
      await writeSupportedIntegrations(options)
      const output = readFileSync(outputPath, 'utf8')
      assert.match(output, /^\[\n {4}\{\n {8}"dependencyName": "node:fs"/)
      assert.strictEqual(await checkSupportedIntegrations(options), true)

      writeFileSync(outputPath, '[]\n')
      const consoleError = sinon.stub(console, 'error')
      try {
        assert.strictEqual(await checkSupportedIntegrations(options), false)
        assert.match(consoleError.firstCall.args[0], /Out of date: /)
      } finally {
        consoleError.restore()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('generate supported versions workflow', () => {
  const workflowPath = path.join(repositoryDirectory, '.github/workflows/generate-supported-versions.yml')
  const workflowSource = readFileSync(workflowPath, 'utf8')
  const workflow = YAML.parse(workflowSource)

  it('only updates same-repository pull requests targeting master', () => {
    assert.deepStrictEqual(workflow.on.pull_request.branches, ['master'])
    assert.match(workflow.jobs['update-supported-versions'].if, /github\.base_ref == 'master'/)
    assert.match(
      workflow.jobs['update-supported-versions'].if,
      /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/
    )
    assert.match(workflow.jobs['update-supported-versions'].if, /!\(startsWith\(.+?'v'\).+endsWith\(.+?'\.x'\)\)/s)
  })

  it('accepts a narrower Node.js range and only writes the JSON artifact', () => {
    assert.strictEqual(workflow.on.workflow_dispatch.inputs['node-range'].default, '*')
    assert.match(workflowSource, /--node-range "\$NODE_RANGE"/)
    assert.match(workflowSource, /path: "supported_versions\.json", contents: \$json/)
    assert.doesNotMatch(workflowSource, /supported_versions_(?:output|table)/)
  })
})
