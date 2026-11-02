import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
          node: ['26.2.0'],
        },
        supportedRange: '*',
        tested: [],
      }],
    }])
  })

  it('does not treat unselected release aliases as test runs', async () => {
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

    assert.deepStrictEqual(rows[0].versions[0].testedRuntimes.node, ['26.2.0'])
  })

  it('uses the tested package versions active on each Node.js line', async () => {
    const { rows } = await generateSupportedIntegrations({
      nodeProfiles: [
        { key: '18', version: '18.20.8' },
        { key: '26', version: '26.2.0' },
      ],
      plugins: new Map([['express', 'express']]),
      instrumentations: new Map([
        ['18.20.8', new Map([['express', [{ versions: ['>=4 <5'] }]]])],
        ['26.2.0', new Map([['express', [{ versions: ['>=4 <6'], node: '>=26' }]]])],
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
          node: ['26.2.0'],
        },
        supportedRange: '>=4 <6',
        tested: ['4.0.0', '4.22.1', '5.2.1'],
      }, {
        testedRuntimes: {
          node: ['18.20.8'],
        },
        supportedRange: '>=4 <5',
        tested: ['4.0.0', '4.22.1'],
      }],
    }])
  })

  it('includes versioned integration tests without capping declared support', async () => {
    const profiles = [
      { key: '20', version: '20.20.2' },
      { key: '24', version: '24.16.0' },
      { key: '26', version: '26.2.0' },
    ]
    const plugins = new Map([
      ['@azure/event-hubs', 'azure-event-hubs'],
      ['@azure/service-bus', 'azure-service-bus'],
    ])
    const { rows } = await generateSupportedIntegrations({
      nodeProfiles: profiles,
      plugins,
      instrumentations: new Map(profiles.map(profile =>
        [profile.version, new Map([...plugins.keys()].map(name =>
          [name, [{ versions: [name === '@azure/service-bus' ? '>=7.0.0' : '>=6.0.0'] }]]
        ))]
      )),
      getPackageVersions: dependency => Promise.resolve(dependency === '@azure/service-bus'
        ? ['7.0.0', '7.0.4']
        : ['6.0.0', '6.0.4']),
    })

    assert.deepStrictEqual(rows.map(row => row.integrationName), ['azure-event-hubs', 'azure-service-bus'])
    for (const row of rows) {
      const major = row.integrationName === 'azure-service-bus' ? 7 : 6
      assert.deepStrictEqual(row.versions, [{
        testedRuntimes: { node: ['26.2.0'] },
        supportedRange: `>=${major}.0.0`,
        tested: [`${major}.0.0`, `${major}.0.4`],
      }])
    }
  })

  it('removes ranges covered by another active declaration', async () => {
    const { rows } = await generateSupportedIntegrations({
      nodeProfiles: [{ key: '26', version: '26.2.0' }],
      plugins: new Map([['express', 'express']]),
      instrumentations: new Map([
        ['26.2.0', new Map([['express', [
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
      nodeProfiles: [{ key: '26', version: '26.2.0' }],
      plugins: new Map([['express', 'express']]),
      instrumentations: new Map([
        ['26.2.0', new Map([['express', [
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
      nodeProfiles: [{ key: '26', version: '26.2.0' }],
      plugins: new Map([['express', 'express']]),
      instrumentations: new Map([['26.2.0', new Map()]]),
      getPackageVersions: () => Promise.reject(new Error('Dependencies without hooks do not use npm metadata')),
    })

    assert.deepStrictEqual(rows, [])
  })

  it('omits Node.js lines outside an instrumentation declaration gate', async () => {
    const declarations = [{ versions: ['>=4 <5'], node: '>=26' }]
    const { rows } = await generateSupportedIntegrations({
      nodeProfiles: [
        { key: '18', version: '18.20.8' },
        { key: '26', version: '26.2.0' },
      ],
      plugins: new Map([['express', 'express']]),
      instrumentations: new Map([
        ['18.20.8', new Map([['express', declarations]])],
        ['26.2.0', new Map([['express', declarations]])],
      ]),
      getPackageVersions: () => Promise.resolve(['4.0.0', '4.22.1']),
    })

    assert.deepStrictEqual(rows[0].versions[0].testedRuntimes.node, ['26.2.0'])
  })

  it('uses the Kafka CI runtime and package ranges without narrowing declared support', async () => {
    const declarations = [{ versions: ['>=1.0.0'] }]
    const { rows } = await generateSupportedIntegrations({
      nodeProfiles: [
        { key: '22', version: '22.22.3' },
        { key: '24', version: '24.16.0' },
        { key: '26', version: '26.2.0' },
      ],
      plugins: new Map([['@confluentinc/kafka-javascript', 'confluentinc-kafka-javascript']]),
      instrumentations: new Map([
        ['22.22.3', new Map([['@confluentinc/kafka-javascript', declarations]])],
        ['24.16.0', new Map([['@confluentinc/kafka-javascript', declarations]])],
        ['26.2.0', new Map([['@confluentinc/kafka-javascript', declarations]])],
      ]),
      getPackageVersions: () => Promise.resolve(['1.0.0', '1.3.2', '1.4.0', '1.11.0']),
    })

    assert.deepStrictEqual(rows[0].versions, [{
      testedRuntimes: { node: ['24.16.0'] },
      supportedRange: '>=1.0.0',
      tested: ['1.4.0', '1.11.0'],
    }, {
      testedRuntimes: { node: ['22.22.3'] },
      supportedRange: '>=1.0.0',
      tested: ['1.0.0', '1.11.0'],
    }])
  })

  it('uses alias matrices and included ranges instead of advertising untested runtimes', async () => {
    const declarations = [{ versions: ['>=4.0.0'] }]
    const profiles = [
      { key: '22', version: '22.22.3' },
      { key: '24', version: '24.16.0' },
      { key: '26', version: '26.2.0' },
    ]
    const { rows } = await generateSupportedIntegrations({
      nodeProfiles: profiles,
      plugins: new Map([['aerospike', 'aerospike']]),
      instrumentations: new Map(profiles.map(profile =>
        [profile.version, new Map([['aerospike', declarations]])]
      )),
      getPackageVersions: () => Promise.resolve([
        '4.0.0', '4.0.5', '5.0.0', '5.12.1', '5.13.2', '6.0.0', '6.7.1', '7.0.1',
      ]),
    })

    assert.deepStrictEqual(rows.flatMap(row => row.versions.flatMap(version => version.testedRuntimes.node)),
      ['22.22.3'])
    assert.ok(!rows[0].versions[0].tested.includes('4.0.0'))
    assert.strictEqual(rows[0].versions[0].supportedRange, '>=4.0.0')
  })

  it('does not advertise Couchbase on runtimes absent from either test workflow', async () => {
    const profiles = [
      { key: '22', version: '22.22.3' },
      { key: '24', version: '24.16.0' },
      { key: '26', version: '26.2.0' },
    ]
    const { rows } = await generateSupportedIntegrations({
      nodeProfiles: profiles,
      plugins: new Map([['couchbase', 'couchbase']]),
      instrumentations: new Map(profiles.map(profile =>
        [profile.version, new Map([['couchbase', [{ versions: ['>=4.2.0'] }]]])]
      )),
      getPackageVersions: () => Promise.resolve(['4.2.0', '4.6.0']),
    })

    assert.deepStrictEqual(rows, [])
  })

  it('uses include-only matrices and resolves composite action inputs', async () => {
    const profiles = [
      { key: '18', version: '18.20.8' },
      { key: '20', version: '20.20.2' },
      { key: '24', version: '24.16.0' },
      { key: '26', version: '26.2.0' },
    ]
    const plugins = new Map([['@prisma/client', 'prisma'], ['mariadb', 'mariadb'], ['pino', 'pino']])
    const { rows } = await generateSupportedIntegrations({
      nodeProfiles: profiles,
      plugins,
      instrumentations: new Map(profiles.map(profile =>
        [profile.version, new Map([...plugins.keys()].map(name =>
          [name, [{ versions: [name === 'mariadb' ? '>=3.0.0' : '6.1.0'] }]]
        ))]
      )),
      getPackageVersions: dependency => Promise.resolve(dependency === 'mariadb'
        ? ['2.5.6', '3.0.0', '3.4.0', '3.4.5', '3.5.1', '3.5.2', '3.5.3', '3.5.4']
        : ['6.1.0', '6.9.0', '7.0.0']),
    })

    const runtimes = name => rows.find(row => row.integrationName === name).versions.flatMap(version =>
      version.testedRuntimes.node
    )
    assert.deepStrictEqual(runtimes('prisma'), ['26.2.0', '18.20.8'])
    assert.deepStrictEqual(runtimes('mariadb'), ['26.2.0', '18.20.8'])
    assert.deepStrictEqual(runtimes('pino'), ['26.2.0', '20.20.2'])
  })

  it('applies matrix exclusions, re-inclusions, step conditions, and package filters', async () => {
    await withTestWorkflow({
      jobs: {
        selected: {
          strategy: {
            matrix: {
              version: [22, 24],
              range: ['>=4 <5'],
              exclude: [{ version: 24 }],
              include: [{ version: 24, range: '>=5 <6' }, { version: 22, extra: true }],
            },
          },
          env: {
            PLUGINS: 'express',
            PACKAGE_NAMES: workflowExpression('matrix.packages'),
            PACKAGE_VERSION_RANGE: workflowExpression('matrix.range'),
          },
          steps: [{ uses: './.github/actions/node', with: { version: workflowExpression('matrix.version') } }, {
            if: "matrix.version != '24' || matrix.extra == 'true'",
            run: 'npm run test:plugins:ci',
          }, {
            if: "matrix.version == '24' && matrix.extra != 'true'",
            run: 'npm run test:instrumentations:ci',
          }],
        },
        filtered: {
          env: { PLUGINS: 'express', PACKAGE_NAMES: 'other' },
          steps: [{ uses: './.github/actions/node', with: { version: 22 } }, {
            run: 'npm run test:plugins:ci',
          }, { uses: './.github/actions/node' }, {
            run: 'npm run test:plugins:ci',
          }],
        },
      },
    }, async () => {
      const { rows } = await generateSupportedIntegrations(workflowOptions())
      assert.deepStrictEqual(rows[0].versions, [{
        testedRuntimes: { node: ['24.16.0'] }, supportedRange: '>=4 <6', tested: ['5.0.0', '5.2.1'],
      }, {
        testedRuntimes: { node: ['22.22.3'] }, supportedRange: '>=4 <6', tested: ['4.0.0', '4.22.1'],
      }])
    })
  })

  for (const [name, setup, expected] of [
    ['runtime expressions', { uses: './.github/actions/node', with: { version: workflowExpression('env.CUSTOM') } },
      /Unsupported test workflow expression/],
    ['conditions', { uses: './.github/actions/node', if: 'unknown()', with: { version: 22 } },
      /Unsupported test workflow condition/],
    ['versions', { uses: './.github/actions/node', with: { version: 'unknown' } }, /Invalid test Node.js version/],
    ['missing setup', undefined, /Test workflow runs without an explicit Node.js version/],
  ]) {
    it(`rejects unknown workflow ${name}`, async () => {
      await withTestWorkflow({
        jobs: {
          selected: {
            env: { PLUGINS: 'express' },
            steps: [...(setup ? [setup] : []), { run: 'npm run test:plugins:ci' }],
          },
        },
      }, async () => {
        await assert.rejects(generateSupportedIntegrations(workflowOptions()), expected)
      })
    })
  }

  it('uses the CI alias resolver with pinned versions, sparse checkouts, and custom latest versions', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'dd-node-alias-'))
    const action = YAML.parse(readFileSync(path.join(repositoryDirectory,
      '.github/actions/node/setup/action.yml'), 'utf8'))
    const command = action.runs.steps.find(step => step.id === 'node-version').run
    const output = path.join(directory, 'output')
    const envOutput = path.join(directory, 'env')
    try {
      for (const [alias, expected] of Object.entries({
        eol: '16', oldest: '18.20.8', maintenance: '20.20.2', active: '24.16.0', latest: '26.2.0', 22: '22',
      })) {
        const result = spawnSync('bash', ['-c', command], {
          cwd: repositoryDirectory,
          env: { ...process.env, VERSION: alias, LATEST_VERSION: '', GITHUB_OUTPUT: output },
        })
        assert.strictEqual(result.status, 0, String(result.stderr))
        assert.ok(readFileSync(output, 'utf8').endsWith(`version=${expected}\n`))
      }
      const script = path.join(repositoryDirectory, '.github/actions/node/setup/resolve-version.sh')
      const sparse = spawnSync('bash', [script], {
        cwd: directory, env: { ...process.env, VERSION: 'maintenance' }, encoding: 'utf8',
      })
      assert.strictEqual(sparse.status, 0)
      assert.strictEqual(sparse.stdout, 'version=20\n')
      const custom = spawnSync('bash', [script], {
        cwd: repositoryDirectory,
        env: { ...process.env, VERSION: 'latest', LATEST_VERSION: '27.0.0-nightly', GITHUB_ENV: envOutput },
        encoding: 'utf8',
      })
      assert.strictEqual(custom.status, 0)
      assert.strictEqual(custom.stdout, 'version=27.0.0-nightly\n')
      assert.strictEqual(readFileSync(envOutput, 'utf8'), 'DD_INJECT_FORCE=true\n')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('merges matching test externals and applies their runtime gates only to tested coverage', async () => {
    const declarations = [{ versions: ['>=3.0.0'] }]
    const { rows } = await generateSupportedIntegrations({
      nodeProfiles: [
        { key: '18', version: '18.20.8' },
        { key: '26', version: '26.2.0' },
      ],
      plugins: new Map([['mariadb', 'mariadb']]),
      instrumentations: new Map([
        ['18.20.8', new Map([['mariadb', declarations]])],
        ['26.2.0', new Map([['mariadb', declarations]])],
      ]),
      getPackageVersions: () => Promise.resolve([
        '2.5.6', '3.0.0', '3.4.0', '3.4.5', '3.5.1', '3.5.2', '3.5.3', '3.5.4',
      ]),
    })

    assert.deepStrictEqual(rows[0].versions, [{
      testedRuntimes: { node: ['26.2.0'] },
      supportedRange: '>=3.0.0',
      tested: ['2.5.6', '3.0.0', '3.4.0', '3.4.5', '3.5.1', '3.5.2', '3.5.3', '3.5.4'],
    }, {
      testedRuntimes: { node: ['18.20.8'] },
      supportedRange: '>=3.0.0',
      tested: ['2.5.6', '3.0.0', '3.4.0', '3.4.5', '3.5.1', '3.5.2', '3.5.4'],
    }])
  })

  it('does not let test externals enable an inactive instrumentation declaration', async () => {
    const declarations = [{ versions: ['>=3.0.0'], node: '>=20' }]
    const { rows } = await generateSupportedIntegrations({
      nodeProfiles: [{ key: '18', version: '18.20.8' }],
      plugins: new Map([['mariadb', 'mariadb']]),
      instrumentations: new Map([
        ['18.20.8', new Map([['mariadb', declarations]])],
      ]),
      getPackageVersions: () => Promise.resolve([
        '2.5.6', '3.0.0', '3.4.0', '3.4.5', '3.5.1', '3.5.2', '3.5.3', '3.5.4',
      ]),
    })

    assert.deepStrictEqual(rows, [])
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
        nodeProfiles: [{ key: '26', version: '26.2.0' }],
        plugins: new Map([['express', 'express']]),
        instrumentations: new Map([
          ['26.2.0', new Map([['express', [{ versions: ['1.0.0'] }]]])],
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
    for (const args of [['--node-range'], ['--node-range', '--node-range']]) {
      const result = spawnSync(process.execPath, [generatorPath, ...args], { encoding: 'utf8' })

      assert.strictEqual(result.status, 1)
      assert.match(result.stderr, /--node-range requires a semver range/)
    }
  })

  it('writes the JSON artifact', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'dd-supported-versions-'))
    const outputPath = path.join(directory, 'supported_versions.json')
    const options = {
      nodeProfiles: [{ key: '26', version: '26.2.0' }],
      plugins: new Map([['fs', 'fs']]),
      instrumentations: new Map([['26.2.0', new Map()]]),
      getPackageVersions: () => Promise.reject(new Error('Node.js built-ins do not use npm metadata')),
      outputPath,
    }

    try {
      await writeSupportedIntegrations(options)
      const output = readFileSync(outputPath, 'utf8')
      assert.match(output, /^\[\n {4}\{\n {8}"dependencyName": "node:fs"/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

/**
 * @param {object} workflow
 * @param {() => Promise<void>} check
 */
async function withTestWorkflow (workflow, check) {
  const source = readFileSync(path.join(repositoryDirectory, '.github/workflows/apm-integrations.yml'), 'utf8')
  const parse = YAML.parse
  const stub = sinon.stub(YAML, 'parse').callsFake(value => value === source ? workflow : parse(value))
  try {
    await check()
  } finally {
    stub.restore()
  }
}

function workflowOptions () {
  const declarations = [{ versions: ['>=4 <6'] }]
  return {
    nodeProfiles: [{ key: '22', version: '22.22.3' }, { key: '24', version: '24.16.0' }],
    plugins: new Map([['express', 'express']]),
    instrumentations: new Map([
      ['22.22.3', new Map([['express', declarations]])],
      ['24.16.0', new Map([['express', declarations]])],
    ]),
    getPackageVersions: () => Promise.resolve(['4.0.0', '4.22.1', '5.0.0', '5.2.1']),
  }
}

/**
 * @param {string} value
 */
function workflowExpression (value) {
  return `\${{ ${value} }}`
}
