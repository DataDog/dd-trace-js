import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it } from 'mocha'

const repositoryDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const verifierPath = join(repositoryDirectory, 'scripts', 'verify-integration-skills.js')
const skillFiles = {
  '.agents/skills/apm-integrations/SKILL.md': `---
name: apm-integrations
description: Verify an APM integration.
---
# APM integrations

[Orchestrion](references/orchestrion.md)
[External](https://example.com)
[Section](#apm-integrations)

Read \`packages/dd-trace/src/plugins/tracing.js\`.
Run \`npm run inspect:integration\`.
`,
  '.agents/skills/apm-integrations/references/orchestrion.md': '# Orchestrion\n',
  '.agents/skills/apm-integrations/references/shimmer.md': '# Shimmer\n',
  '.agents/skills/apm-integrations/references/testing.md': '# Testing integrations\n',
  '.agents/skills/serverless-integrations/SKILL.md': `---
name: serverless-integrations
description: Verify a serverless integration.
---
# Serverless integrations

[Testing](references/testing-guide.md)
`,
  '.agents/skills/serverless-integrations/references/testing-guide.md': '# Testing serverless integrations\n',
}
const metadataFiles = {
  '.agents/skills/apm-integrations/agents/openai.yaml': `interface:
  display_name: "APM integrations"
  short_description: "Build and review dd-trace-js integrations"
  default_prompt: "Use $apm-integrations to review this integration."
`,
  '.agents/skills/serverless-integrations/agents/openai.yaml': `interface:
  display_name: "Serverless integrations"
  short_description: "Review cloud-function tracing ownership"
  default_prompt: "Use $serverless-integrations to review this integration."
`,
}
const sourceFiles = {
  'package.json': JSON.stringify({ scripts: { 'inspect:integration': 'fixture' } }),
  'packages/dd-trace/src/plugins/tracing.js': 'startSpan (name, options = {}, enterOrCtx = true) {}\n',
  'packages/dd-trace/src/plugins/cache.js': `const StoragePlugin = require('./storage')
class CachePlugin extends StoragePlugin {
  static operation = 'command'
  startSpan (options, ctx) {}
}
module.exports = CachePlugin
`,
  'packages/dd-trace/src/plugins/producer.js': 'startSpan (options, enterOrCtx) {}\n',
  'packages/dd-trace/src/plugins/consumer.js': 'startSpan (options, enterOrCtx) {}\n',
  'packages/datadog-instrumentations/src/helpers/hooks.js': `module.exports = {
  esmFirst: true,
  serverless: false,
  'fixture-package-extra': () => require('../fixture-extra'),
  'fixture-package': () => require('../fixture'),
  ['fixture-package-' + 'alias']: { esmFirst: true, fn: () => require('../fixture') },
  'outside-package': () => require('../../../../../outside'),
  'shared-package': () => require('../shared'),
  'alpha-no-index-package': () => require('../alpha-no-index'),
}
`,
  'packages/datadog-instrumentations/src/alpha-no-index.js': 'module.exports = {}\n',
  'packages/datadog-instrumentations/src/fixture.js': 'module.exports = {}\n',
  'packages/datadog-instrumentations/src/shared.js': 'module.exports = {}\n',
  'packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/fixture.js': `module.exports = [{
  module: { name: 'fixture-package', versionRange: '>=1', filePath: 'dist/cjs/client.js' },
  functionQuery: { methodName: 'run', className: 'Client', kind: "Auto" },
  channelName: 'Client_run',
}, {
  module: { name: 'fixture-package', versionRange: '>=1', filePath: 'dist/esm/client.js' },
  functionQuery: { methodName: 'run', className: 'Client', kind: 'Async' },
  channelName: 'Client_run',
}]
`,
  'packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/fallback.js': 'module.exports = []\n',
  'packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/index.js':
    "module.exports = [...require('./alpha-no-index'), ...require('./fixture'), ...require('./shared')]\n",
  'packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/alpha-no-index.js': `module.exports = [{
  module: { name: 'alpha-no-index-package' },
  functionQuery: { kind: 'Async' },
}]
`,
  'packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/shared.js': `module.exports = [{
  module: { name: 'shared-package' },
  functionQuery: { kind: 'Callback' },
}]
`,
  'packages/datadog-plugin-fixture/src/helper.js': 'module.exports = {}\n',
  'packages/datadog-plugin-fixture/src/README.md': '# Fixture\n',
  'packages/datadog-plugin-fixture/src/index.js': `const CachePlugin = require('../../dd-trace/src/plugins/cache')
class FixturePlugin extends CachePlugin {
  // static prefix = 'ignored-comment'
  static get prefix () { return 'fixture-prefix' } static get ignored () { this.noop() }
  static type = 'missing-schema'
  static ignoredField
  operation () { this.operationName({ ...this.options }) }
}
module.exports = FixturePlugin
`,
  'packages/datadog-plugin-fixture/test/index.spec.js': 'describe(\'fixture\', () => {})\n',
  'packages/datadog-plugin-fixture/test/nested/cjs.spec.cjs': 'describe(\'fixture cjs\', () => {})\n',
  'packages/datadog-plugin-fixture/test/nested/esm.spec.mjs': 'describe(\'fixture esm\', () => {})\n',
  'packages/datadog-plugin-derived/src/index.js': `const DatabasePlugin = require('../../dd-trace/src/plugins/database')
class DerivedPlugin extends DatabasePlugin {}
module.exports = DerivedPlugin
`,
  'packages/datadog-plugin-link/src/index.js': `const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
module.exports = ProducerPlugin
`,
  'packages/datadog-plugin-alpha-no-index/src/plugin.js':
    "module.exports = require('../../dd-trace/src/plugins/producer')\n",
  'packages/dd-trace/src/plugins/database.js': `const StoragePlugin = require('./storage')
class DatabasePlugin extends StoragePlugin {}
module.exports = DatabasePlugin
`,
  'packages/dd-trace/src/plugins/storage.js': `class StoragePlugin {
  static type = 'storage'
  static kind = 'client'
  startSpan (name, options, ctx) {}
}
module.exports = StoragePlugin
`,
  'packages/dd-trace/src/service-naming/schemas/v0/storage.js': 'module.exports = {}\n',
  'packages/dd-trace/src/service-naming/schemas/v1/storage.js': 'module.exports = {}\n',
  'packages/dd-trace/src/plugins/index.js': `module.exports = {
  get 'fixture-package-extra' () { return require('../../../datadog-plugin-fixture-extra/src') },
  get 'fixture-package' () { return require('../../../datadog-plugin-fixture/src') },
  get ['fixture-package-' + 'alias'] () { return require('../../../datadog-plugin-fixture/src') },
  serverless: false,
  get 'shared-package' () { return require('../../../datadog-plugin-link/src') },
  get 'alpha-no-index-package' () { return require('../../../datadog-plugin-alpha-no-index/src/plugin') },
}
`,
  'packages/dd-trace/test/plugins/versions/package.json': JSON.stringify({
    dependencies: { 'fixture-package': '1.0.0' },
  }),
  'index.d.ts': '"fixture": object\n',
  'index.d.v5.ts': '"fixture": object\n',
  'docs/API.md': '* [fixture](#fixture)\n',
  'docs/test.ts': "tracer.use('fixture')\n",
  '.github/workflows/apm-integrations.yml': 'PLUGINS: fixture-extra\nPLUGINS: other|fixture\n',
  '.github/workflows/serverless.yml': 'name: Serverless\n',
  'integration-tests/helpers/index.js': "'destructure' | 'direct' | 'namespace'\n",
  'packages/dd-trace/src/lambda/index.js': 'module.exports = {}\n',
  'packages/dd-trace/src/lambda/README.md': '# Lambda\n',
  '.github/CODEOWNERS': `/.agents/skills/apm-integrations/ @DataDog/apm-idm-js
/.agents/skills/serverless-integrations/ @DataDog/serverless-aws @DataDog/apm-serverless
/packages/datadog-plugin-fixture-extra/ @DataDog/apm-idm-js
/packages/datadog-plugin-fixture/ @DataDog/apm-idm-js
`,
  'vendor/package-lock.json': JSON.stringify({
    packages: {
      'node_modules/@apm-js-collab/code-transformer': { version: 'fixture' },
    },
  }),
}

/**
 * @param {string} root
 * @param {string} filename
 * @param {string} source
 * @returns {void}
 */
function writeFixtureFile (root, filename, source) {
  const absoluteFilename = join(root, filename)
  mkdirSync(dirname(absoluteFilename), { recursive: true })
  writeFileSync(absoluteFilename, source)
}

/**
 * @param {string} root
 * @returns {void}
 */
function writeControlRegistry (root) {
  const source = String.raw`module.exports = {
  '\u001B[31m\u009B\u202E\u2028\u2029\u{E0001}fixture': () => require('../fixture'),
}
`
  writeFixtureFile(
    root,
    'packages/datadog-instrumentations/src/helpers/hooks.js',
    source
  )
}

/**
 * @param {string[]} [args]
 * @param {(root: string) => void} [mutate]
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function runTool (args = [], mutate) {
  const root = mkdtempSync(join(tmpdir(), 'dd-integration-skills-'))

  try {
    for (const [filename, source] of Object.entries({ ...skillFiles, ...metadataFiles, ...sourceFiles })) {
      writeFixtureFile(root, filename, source)
    }

    const claudeSkills = join(root, '.claude', 'skills')
    mkdirSync(claudeSkills, { recursive: true })
    symlinkSync('../../.agents/skills/apm-integrations', join(claudeSkills, 'apm-integrations'))
    symlinkSync('../../.agents/skills/serverless-integrations', join(claudeSkills, 'serverless-integrations'))
    mutate?.(root)

    const { status, stdout, stderr } = spawnSync(process.execPath, [verifierPath, ...args], {
      cwd: root,
      encoding: 'utf8',
    })
    return { status, stdout, stderr }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/**
 * @param {string[]} args
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function runRepositoryTool (args) {
  return spawnSync(process.execPath, [verifierPath, ...args], { encoding: 'utf8' })
}

/**
 * @param {typeof runTool | typeof runRepositoryTool} run
 * @param {string} integration
 * @param {string[]} [args]
 * @param {(root: string) => void} [mutate]
 */
function inspect (run, integration, args = [], mutate) {
  const { status, stdout, stderr } = run(['--inspect', integration, ...args, '--json'], mutate)
  assert.strictEqual(status, 0, stderr)
  return JSON.parse(stdout)
}

describe('verify-integration-skills', () => {
  it('verifies its own repository', () => {
    const { status, stdout } = spawnSync(process.execPath, [verifierPath], { encoding: 'utf8' })

    assert.strictEqual(status, 0)
    assert.match(stdout, /^Integration skills: \d+ \/ 4000 tokens \(o200k_base\)$/m)
    assert.match(stdout, /^Vendored code transformer: \d+\.\d+\.\d+ /m)
  })

  it('accepts a compact checkout whose contracts match', () => {
    const { status, stdout } = runTool()

    assert.strictEqual(status, 0)
    assert.match(stdout, /Vendored code transformer: fixture/)
  })

  it('rejects handbook growth outside the reviewed inventory', () => {
    const { status, stderr } = runTool([], (root) => {
      writeFixtureFile(root, '.agents/skills/apm-integrations/references/extra.md', '# Extra\n')
    })

    assert.strictEqual(status, 1)
    assert.match(stderr, /expected exactly these skill files/)
  })

  it('rejects missing skill and source contracts', () => {
    const { status, stderr } = runTool([], (root) => {
      rmSync(join(root, '.agents/skills/serverless-integrations'), { recursive: true })
      rmSync(join(root, 'packages/dd-trace/src/plugins/cache.js'))
      rmSync(join(root, 'packages/dd-trace/src/lambda'), { recursive: true })
      rmSync(join(root, '.claude/skills/apm-integrations'))
      rmSync(join(root, '.claude/skills/serverless-integrations'))
      mkdirSync(join(root, '.claude/skills/serverless-integrations'))
      rmSync(join(root, 'vendor/package-lock.json'))
    })

    assert.strictEqual(status, 1)
    assert.match(stderr, /missing skill file .*serverless-integrations\/SKILL\.md/)
    assert.match(stderr, /missing source contract file packages\/dd-trace\/src\/plugins\/cache\.js/)
    assert.match(stderr, /missing source contract directory packages\/dd-trace\/src\/lambda/)
    assert.match(stderr, /missing discovery link \.claude\/skills\/apm-integrations/)
    assert.match(stderr, /serverless-integrations: must be a symbolic link/)
    assert.match(stderr, /missing source contract file vendor\/package-lock\.json/)
  })

  it('rejects a skill without frontmatter', () => {
    const { status, stderr } = runTool([], (root) => {
      const skill = join(root, '.agents/skills/apm-integrations/SKILL.md')
      writeFileSync(skill, '# APM integrations\n')
    })

    assert.strictEqual(status, 1)
    assert.match(stderr, /missing YAML frontmatter/)
  })

  it('rejects stale source paths and contracts', () => {
    const { status, stderr } = runTool([], (root) => {
      const skill = join(root, '.agents/skills/apm-integrations/SKILL.md')
      writeFileSync(skill, `${skillFiles['.agents/skills/apm-integrations/SKILL.md']}\nRead \`packages/missing.js\`.\n`)
      writeFixtureFile(root, 'packages/dd-trace/src/plugins/cache.js', 'startSpan (name, options, ctx) {}\n')
    })

    assert.strictEqual(status, 1)
    assert.match(stderr, /missing referenced path packages\/missing\.js/)
    assert.match(stderr, /CachePlugin\.startSpan signature changed/)
  })

  it('rejects stale npm commands', () => {
    const { status, stderr } = runTool([], (root) => {
      const skill = join(root, '.agents/skills/apm-integrations/SKILL.md')
      writeFileSync(skill, `${skillFiles['.agents/skills/apm-integrations/SKILL.md']}\nRun \`npm run missing\`.\n`)
      writeFixtureFile(root, 'package.json', '{}')
    })

    assert.strictEqual(status, 1)
    assert.match(stderr, /missing npm script missing/)
  })

  it('rejects an npm command without a package manifest', () => {
    const { status, stderr } = runTool([], (root) => {
      const skill = join(root, '.agents/skills/apm-integrations/SKILL.md')
      writeFileSync(skill, `${skillFiles['.agents/skills/apm-integrations/SKILL.md']}\nRun \`npm run missing\`.\n`)
      rmSync(join(root, 'package.json'))
    })

    assert.strictEqual(status, 1)
    assert.match(stderr, /cannot validate npm commands without package\.json/)
  })

  it('rejects npm commands against an invalid package manifest', () => {
    const { status, stderr } = runTool([], (root) => {
      const skill = join(root, '.agents/skills/apm-integrations/SKILL.md')
      writeFileSync(skill, `${skillFiles['.agents/skills/apm-integrations/SKILL.md']}\nRun \`npm run missing\`.\n`)
      writeFixtureFile(root, 'package.json', '{')
    })

    assert.strictEqual(status, 1)
    assert.match(stderr, /cannot validate npm commands: /)
  })

  it('rejects stored versions', () => {
    const { status, stderr } = runTool([], (root) => {
      const skill = join(root, '.agents/skills/serverless-integrations/SKILL.md')
      writeFileSync(skill, `${skillFiles['.agents/skills/serverless-integrations/SKILL.md']}\nUse version 1.2.3.\n`)
    })

    assert.strictEqual(status, 1)
    assert.match(stderr, /store no version pins; derive them from source/)
  })

  it('reports malformed metadata instead of crashing', () => {
    const { status, stderr } = runTool([], (root) => {
      const skill = join(root, '.agents/skills/apm-integrations/SKILL.md')
      writeFileSync(skill, '---\nname: [\n---\n# Invalid\n')
      writeFixtureFile(root, 'vendor/package-lock.json', '{')
    })

    assert.strictEqual(status, 1)
    assert.match(stderr, /invalid YAML frontmatter/)
    assert.match(stderr, /vendor\/package-lock\.json: invalid JSON/)
  })

  it('rejects a file over its token budget', () => {
    const { status, stderr } = runTool([], (root) => {
      const reference = join(root, '.agents/skills/apm-integrations/references/shimmer.md')
      writeFileSync(reference, `# Shimmer\n${'word '.repeat(300)}`)
    })

    assert.strictEqual(status, 1)
    assert.match(stderr, /shimmer\.md: .* tokens exceeds its 250-token budget/)
  })

  it('rejects invocation span ownership moving into the Lambda bootstrap', () => {
    const { status, stderr } = runTool([], (root) => {
      writeFixtureFile(root, 'packages/dd-trace/src/lambda/index.js', 'tracer.startSpan()\n')
    })

    assert.strictEqual(status, 1)
    assert.match(stderr, /lambda\/index\.js: Lambda now starts a span/)
  })

  it('reports a compact source-derived integration packet', () => {
    const packet = inspect(runTool, 'fixture', [
      '--package',
      'fixture-package',
      '--mode',
      'review',
      '--traits',
      'auto,cjs-esm,cache',
    ])

    assert.strictEqual(packet.integration, 'fixture')
    assert.strictEqual(packet.mode, 'review')
    assert.deepStrictEqual(packet.traits, ['auto', 'cjs-esm', 'cache'])
    assert.strictEqual(packet.targets.instrumentation, 'packages/datadog-instrumentations/src/fixture.js')
    assert.strictEqual(
      packet.targets.rewriter,
      'packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/fixture.js'
    )
    assert.deepStrictEqual(packet.targets.plugins, [
      'packages/datadog-plugin-fixture/src/helper.js',
      'packages/datadog-plugin-fixture/src/index.js',
    ])
    assert.deepStrictEqual(packet.targets.dependents, [])
    assert.strictEqual(packet.targets.tests.length, 3)
    assert.deepStrictEqual(packet.packages, [
      {
        name: 'fixture-package',
        requested: true,
        hook: 'packages/datadog-instrumentations/src/helpers/hooks.js:5',
        plugin: 'packages/dd-trace/src/plugins/index.js:3',
        version: {
          value: '1.0.0',
          source: 'packages/dd-trace/test/plugins/versions/package.json:1',
        },
      },
      {
        name: 'fixture-package-alias',
        requested: false,
        hook: 'packages/datadog-instrumentations/src/helpers/hooks.js:6',
        plugin: 'packages/dd-trace/src/plugins/index.js:4',
      },
    ])
    assert.deepStrictEqual(packet.evidence.contractSources, [
      'packages/dd-trace/src/plugins/cache.js',
      'packages/dd-trace/src/plugins/storage.js',
    ])
    assert.deepStrictEqual(packet.evidence.channelAnchors, [
      'packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/fixture.js:4',
      'packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/fixture.js:8',
      'packages/datadog-plugin-fixture/src/index.js:4',
    ])
    assert.strictEqual(Object.hasOwn(packet, 'contract'), false)
    assert.deepStrictEqual(packet.registrations.rewriter, [
      'packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/index.js:1',
    ])
    assert.deepStrictEqual(packet.registrations.types, ['index.d.ts:1'])
    assert.deepStrictEqual(packet.registrations.v5Types, ['index.d.v5.ts:1'])
    assert.deepStrictEqual(packet.registrations.docs, ['docs/API.md:1'])
    assert.deepStrictEqual(packet.registrations.docsTest, ['docs/test.ts:1'])
    assert.deepStrictEqual(packet.registrations.codeowners, ['.github/CODEOWNERS:4'])
    assert.deepStrictEqual(packet.registrations.workflows, ['.github/workflows/apm-integrations.yml:2'])
    assert.strictEqual(packet.reference, undefined)
    assert.deepStrictEqual(packet.references, [
      '.agents/skills/apm-integrations/references/orchestrion.md',
      'packages/dd-trace/src/plugins/cache.js',
      '.agents/skills/apm-integrations/references/testing.md',
    ])
  })

  it('does not execute registries from the inspected checkout', () => {
    const packet = inspect(runTool, 'fixture', [], (root) => {
      const hooks = 'packages/datadog-instrumentations/src/helpers/hooks.js'
      const plugins = 'packages/dd-trace/src/plugins/index.js'
      writeFixtureFile(root, hooks, `throw new Error('hooks registry executed')\n${sourceFiles[hooks]}`)
      writeFixtureFile(root, plugins, `throw new Error('plugin registry executed')\n${sourceFiles[plugins]}`)
    })

    assert.strictEqual(packet.packages[0].hook, 'packages/datadog-instrumentations/src/helpers/hooks.js:6')
    assert.strictEqual(packet.packages[0].plugin, 'packages/dd-trace/src/plugins/index.js:4')
  })

  it('uses only statically resolvable registry entries', () => {
    const packet = inspect(runTool, 'fixture', [], (root) => {
      writeFixtureFile(root, 'packages/datadog-instrumentations/src/helpers/hooks.js', `
const dynamicName = 'fixture-dynamic'
module.exports = {
  [\`fixture-template\`]: () => require(\`../fixture\`),
  'static-loader': () => require('../fix' + 'ture'),
  'comment-loader': () => { /* require('../fixture') */ return require(dynamicName) },
  'string-loader': () => "require('../fixture')",
  'dynamic-loader': () => require(dynamicName),
  [1]: () => require('../fixture'),
  [dynamicName]: () => require('../fixture'),
  ['fixture-' + dynamicName]: () => require('../fixture'),
  [\`fixture-\${dynamicName}\`]: () => require('../fixture'),
  'object-without-loader': { file: '../fixture' },
  ...{},
}
globalThis.registryWasParsed = true
`)
      writeFixtureFile(root, 'packages/dd-trace/src/plugins/index.js', `
const dynamicName = 'fixture-dynamic'
const plugins = {
  get [\`fixture-template\`] () { return require(\`../../../datadog-plugin-fixture/src\`) },
  get 'static-loader' () { return require('../../../datadog-plugin-fixt' + 'ure/src') },
  get 'comment-loader' () {
    /* require('../../../datadog-plugin-fixture/src') */
    return require(dynamicName)
  },
  get 'string-loader' () { return "require('../../../datadog-plugin-fixture/src')" },
  get [1] () { return require('../../../datadog-plugin-fixture/src') },
  get [dynamicName] () { return require('../../../datadog-plugin-fixture/src') },
  get ['fixture-' + dynamicName] () { return require('../../../datadog-plugin-fixture/src') },
  get [\`fixture-\${dynamicName}\`] () { return require('../../../datadog-plugin-fixture/src') },
}
module.exports = plugins
`)
      writeFixtureFile(root, 'packages/datadog-plugin-fixture/src/helper.js', `
const decoy = "require('../../dd-trace/src/plugins/database')"
module.exports = require('../../dd-trace/src/plugins/pro' + 'ducer')
`)
      writeFixtureFile(
        root,
        'packages/datadog-plugin-decoy/src/index.js',
        "module.exports = \"require('../../datadog-plugin-fixture/src')\"\n"
      )
      writeFixtureFile(root, 'packages/datadog-plugin-decoy/src/invalid.js', 'module.exports = {\n')
      writeFixtureFile(
        root,
        'packages/datadog-plugin-dependent/src/index.js',
        "module.exports = require('../../datadog-plugin-fixt' + 'ure/src')\n"
      )
    })

    assert.deepStrictEqual(packet.packages.map(({ name }) => name), ['fixture-template', 'static-loader'])
    assert.match(packet.packages[0].hook, /packages\/datadog-instrumentations\/src\/helpers\/hooks\.js:/)
    assert.match(packet.packages[0].plugin, /packages\/dd-trace\/src\/plugins\/index\.js:/)
    assert.match(packet.packages[1].hook, /packages\/datadog-instrumentations\/src\/helpers\/hooks\.js:/)
    assert.match(packet.packages[1].plugin, /packages\/dd-trace\/src\/plugins\/index\.js:/)
    assert.deepStrictEqual(packet.evidence.contractSources, [
      'packages/dd-trace/src/plugins/cache.js',
      'packages/dd-trace/src/plugins/producer.js',
      'packages/dd-trace/src/plugins/storage.js',
    ])
    assert.deepStrictEqual(packet.targets.dependents, [
      'packages/datadog-plugin-dependent/src/index.js',
    ])
  })

  it('escapes control characters in human-readable evidence', () => {
    const { status, stdout, stderr } = runTool(['--inspect', 'fixture'], writeControlRegistry)
    const jsonResult = runTool(['--inspect', 'fixture', '--json'], writeControlRegistry)

    assert.strictEqual(status, 0, stderr)
    assert.strictEqual(stdout.includes('\u001B'), false)
    assert.strictEqual(stdout.includes('\u009B'), false)
    assert.strictEqual(stdout.includes('\u202E'), false)
    assert.strictEqual(stdout.includes('\u2028'), false)
    assert.strictEqual(stdout.includes('\u2029'), false)
    assert.strictEqual(stdout.includes('\u{E0001}'), false)
    assert.match(stdout, /\\u001B\[31m\\u009B\\u202E\\u2028\\u2029\\uDB40\\uDC01fixture/)
    assert.strictEqual(jsonResult.status, 0, jsonResult.stderr)
    assert.strictEqual(jsonResult.stdout.includes('\u009B'), false)
    assert.strictEqual(jsonResult.stdout.includes('\u202E'), false)
    assert.strictEqual(jsonResult.stdout.includes('\u2028'), false)
    assert.strictEqual(jsonResult.stdout.includes('\u2029'), false)
    assert.strictEqual(jsonResult.stdout.includes('\u{E0001}'), false)
    assert.strictEqual(JSON.parse(jsonResult.stdout).packages.some(({ name }) => name.includes('\u009B')), true)
    assert.strictEqual(JSON.parse(jsonResult.stdout).packages.some(({ name }) => name.includes('\u202E')), true)
    assert.strictEqual(JSON.parse(jsonResult.stdout).packages.some(({ name }) => name.includes('\u2028')), true)
    assert.strictEqual(JSON.parse(jsonResult.stdout).packages.some(({ name }) => name.includes('\u2029')), true)
    assert.strictEqual(JSON.parse(jsonResult.stdout).packages.some(({ name }) => name.includes('\u{E0001}')), true)
  })

  it('escapes terminal controls in verification failures', () => {
    const filename = '.agents/skills/apm-integrations/SKILL.md'
    const { status, stderr } = runTool([], (root) => {
      writeFixtureFile(root, filename, `${skillFiles[filename]}\n[Broken](\u001B[31m\u202E\u2028\u2029missing)\n`)
    })

    assert.strictEqual(status, 1)
    assert.strictEqual(stderr.includes('\u001B'), false)
    assert.strictEqual(stderr.includes('\u202E'), false)
    assert.strictEqual(stderr.includes('\u2028'), false)
    assert.strictEqual(stderr.includes('\u2029'), false)
    assert.match(stderr, /\\u001B\[31m\\u202E\\u2028\\u2029missing/)
  })

  it('resolves alternate source and rewriter extensions', () => {
    const packet = inspect(runTool, 'alternate', [], (root) => {
      writeFixtureFile(root, 'packages/datadog-instrumentations/src/alternate.cjs', 'module.exports = {}\n')
      writeFixtureFile(
        root,
        'packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/alternate.mjs',
        'export default []\n'
      )
    })

    assert.strictEqual(packet.targets.instrumentation, 'packages/datadog-instrumentations/src/alternate.cjs')
    assert.strictEqual(
      packet.targets.rewriter,
      'packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/alternate.mjs'
    )
    assert.deepStrictEqual(packet.registrations.rewriter, [])
  })

  it('routes a closest reference through its linked plugin directory', () => {
    const packet = inspect(runTool, 'new-plugin', ['--traits', 'callback'])

    assert.strictEqual(packet.reference.integration, 'shared')
    assert.strictEqual(
      packet.reference.files.includes('packages/datadog-plugin-link/src/index.js'),
      true
    )
  })

  it('ignores unregistered rewriters as closest references', () => {
    const packet = inspect(runTool, 'new-plugin', ['--traits', 'orchestrion'], (root) => {
      writeFixtureFile(
        root,
        'packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/index.js',
        "module.exports = [...require('./fixture')]\n"
      )
    })

    assert.strictEqual(packet.reference.integration, 'fixture')
  })

  it('uses a registered non-index plugin source as a closest reference', () => {
    const packet = inspect(runTool, 'new-plugin', ['--traits', 'async'])

    assert.strictEqual(packet.reference.integration, 'alpha-no-index')
    assert.strictEqual(
      packet.reference.files.includes('packages/datadog-plugin-alpha-no-index/src/plugin.js'),
      true
    )
  })

  it('keeps an absent integration actionable for add mode', () => {
    const packet = inspect(runTool, 'new-plugin', [
      '--mode',
      'add',
      '--traits',
      'orchestrion,auto,async,cjs-esm,cache',
    ])

    assert.deepStrictEqual(packet.targets.plugins, [])
    assert.deepStrictEqual(packet.packages, [{ name: 'new-plugin', requested: false }])

    assert.deepStrictEqual(inspect(runTool, 'new-plugin', ['--package', '@scope/new-plugin']).packages, [
      { name: '@scope/new-plugin', requested: true },
    ])
    assert.deepStrictEqual(packet.reference, {
      integration: 'fixture',
      files: [
        'packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/fixture.js',
        'packages/datadog-instrumentations/src/fixture.js',
        'packages/datadog-plugin-fixture/src/index.js',
        'packages/datadog-plugin-fixture/test/index.spec.js',
      ],
      registrations: [
        'packages/datadog-instrumentations/src/helpers/hooks.js:5',
        'packages/dd-trace/src/plugins/index.js:3',
        'packages/dd-trace/test/plugins/versions/package.json:1',
        'index.d.ts:1',
        'index.d.v5.ts:1',
        'docs/API.md:1',
        'docs/test.ts:1',
        '.github/CODEOWNERS:4',
        '.github/workflows/apm-integrations.yml:2',
      ],
    })
    assert.strictEqual(packet.references[0], '.agents/skills/apm-integrations/references/orchestrion.md')
  })

  it('rejects unknown inspection options', () => {
    const { status, stderr } = runTool(['--inspect', 'fixture', '--mode', 'invent'])

    assert.strictEqual(status, 1)
    assert.match(stderr, /mode must be add, review, debug, or serverless/)
  })

  it('normalizes duplicate inspection traits', () => {
    const packet = inspect(runTool, 'fixture', ['--traits', 'cache,cache'])

    assert.deepStrictEqual(packet.traits, ['cache'])
    assert.strictEqual(
      packet.references.filter(reference => reference === 'packages/dd-trace/src/plugins/cache.js').length,
      1
    )
  })

  it('rejects missing and invalid CLI values', () => {
    const underscore = inspect(runRepositoryTool, 'child_process')
    const cases = [
      [['--inspect'], /--inspect requires an integration id/],
      [['--inspect', 'fixture', '--package'], /--package requires an npm package name/],
      [['--inspect', 'fixture', '--traits'], /--traits requires a comma-separated value/],
      [['--inspect', 'fixture', '--traits', 'invent'], /unknown integration trait: invent/],
      [['--inspect', 'fixture', '--unknown'], /unknown option: --unknown/],
      [['--inspect', 'fixture', 'extra'], /unexpected argument: extra/],
      [['--inspect', '../fixture'], /integration id must contain only lowercase letters/],
    ]

    assert.deepStrictEqual(underscore.registrations.workflows, ['.github/workflows/apm-integrations.yml:221'])
    for (const [args, expected] of cases) {
      const { status, stderr } = spawnSync(process.execPath, [verifierPath, ...args], { encoding: 'utf8' })
      assert.strictEqual(status, 1)
      assert.match(stderr, expected)
    }
  })

  it('does not infer registration from a prefix sibling', () => {
    const packet = inspect(runTool, 'fix')

    assert.deepStrictEqual(packet.packages, [{ name: 'fix', requested: false }])
    assert.deepStrictEqual(packet.registrations.codeowners, [])
    assert.deepStrictEqual(packet.registrations.workflows, [])
  })

  it('renders the bounded review and debug routes', () => {
    const { status, stdout } = runTool([
      '--inspect',
      'fixture',
      '--mode',
      'debug',
      '--traits',
      'shimmer',
    ])
    const missing = runTool(['--inspect', 'new-plugin', '--traits', 'cache,auto'])
    const noTraits = runTool(['--inspect', 'new-plugin'])

    assert.strictEqual(status, 0)
    assert.match(stdout, /^Integration: fixture$/m)
    assert.match(stdout, /^Packages:$/m)
    assert.match(stdout, /^ {2}fixture-package$/m)
    assert.match(stdout, /^Contract sources:$/m)
    assert.match(stdout, /references\/shimmer\.md/)
    assert.strictEqual(missing.status, 0)
    assert.match(missing.stdout, /^Mode: review; traits: cache, auto$/m)
    assert.match(missing.stdout, /^ {2}instrumentation: missing$/m)
    assert.match(missing.stdout, /^ {2}rewriter: missing$/m)
    assert.match(missing.stdout, /^ {2}plugin sources: 0$/m)
    assert.match(missing.stdout, /^ {2}new-plugin \(candidate\)$/m)
    assert.match(missing.stdout, /^Contract sources:\n {2}none$/m)
    assert.match(missing.stdout, /^ {2}packages\/dd-trace\/src\/plugins\/cache\.js$/m)
    assert.match(missing.stdout, /^Closest current reference: fixture$/m)
    assert.strictEqual(noTraits.status, 0)
    assert.match(noTraits.stdout, /^Mode: review$/m)
    assert.match(noTraits.stdout, /^Contract sources:\n {2}none$/m)
  })

  it('routes serverless proof without APM reference noise', () => {
    const packet = inspect(runTool, 'fixture', ['--mode', 'serverless'], (root) => {
      rmSync(join(root, '.github/workflows/apm-integrations.yml'))
      writeFixtureFile(root, '.github/workflows/serverless.yml', 'PLUGINS: other|fixture\n')
    })

    assert.deepStrictEqual(packet.registrations.workflows, ['.github/workflows/serverless.yml:1'])
    assert.deepStrictEqual(packet.references, [
      '.agents/skills/apm-integrations/references/orchestrion.md',
      '.agents/skills/serverless-integrations/references/testing-guide.md',
    ])
  })

  it('lists inherited plugin contract sources', () => {
    const packet = inspect(runTool, 'derived')
    const missingBase = inspect(runTool, 'derived', [], (root) => {
      rmSync(join(root, 'packages/dd-trace/src/plugins/database.js'))
    })

    assert.deepStrictEqual(packet.evidence.contractSources, [
      'packages/dd-trace/src/plugins/database.js',
      'packages/dd-trace/src/plugins/storage.js',
    ])
    assert.deepStrictEqual(missingBase.evidence.contractSources, [])
  })

  it('reports unavailable optional evidence without failing', () => {
    const packet = inspect(runTool, 'fixture', [], (root) => {
      rmSync(join(root, 'docs/test.ts'))
      rmSync(join(root, '.github/CODEOWNERS'))
      rmSync(join(root, 'packages/dd-trace/test/plugins/versions/package.json'))
    })
    const noDependencies = inspect(runTool, 'fixture', [], (root) => {
      writeFixtureFile(root, 'packages/dd-trace/test/plugins/versions/package.json', '{}')
    })
    const fallbackTest = inspect(runTool, 'new-plugin', ['--traits', 'cache,auto'], (root) => {
      rmSync(join(root, 'packages/datadog-plugin-fixture/test/index.spec.js'))
      rmSync(join(root, 'index.d.v5.ts'))
      rmSync(join(root, '.github/workflows/serverless.yml'))
    })

    assert.strictEqual(packet.packages[0].version, undefined)
    assert.deepStrictEqual(packet.registrations.docsTest, [])
    assert.deepStrictEqual(packet.registrations.codeowners, [])
    assert.strictEqual(noDependencies.packages[0].version, undefined)
    assert.strictEqual(
      fallbackTest.reference.files.at(-1),
      'packages/datadog-plugin-fixture/test/nested/cjs.spec.cjs'
    )
  })

  it('treats unavailable or invalid registry evidence as absent', () => {
    const missingHookRegistry = inspect(runTool, 'fixture', [], (root) => {
      rmSync(join(root, 'packages/datadog-instrumentations/src/helpers/hooks.js'))
    })
    const missingRegistry = inspect(runTool, 'fixture', [], (root) => {
      rmSync(join(root, 'packages/dd-trace/src/plugins/index.js'))
    })
    const invalidRegistry = inspect(runTool, 'fixture', [], (root) => {
      writeFixtureFile(root, 'packages/dd-trace/src/plugins/index.js', 'module.exports = false\n')
    })
    const nullRegistry = inspect(runTool, 'fixture', [], (root) => {
      writeFixtureFile(root, 'packages/dd-trace/src/plugins/index.js', 'module.exports = null\n')
    })
    const malformedRegistry = inspect(runTool, 'fixture', [], (root) => {
      writeFixtureFile(root, 'packages/dd-trace/src/plugins/index.js', 'module.exports = {\n')
    })
    const replacedRegistry = inspect(runTool, 'fixture', [], (root) => {
      const filename = 'packages/dd-trace/src/plugins/index.js'
      writeFixtureFile(root, filename, `${sourceFiles[filename]}module.exports = false\n`)
    })

    assert.strictEqual(missingHookRegistry.packages[0].hook, undefined)
    assert.strictEqual(missingRegistry.packages[0].plugin, undefined)
    assert.strictEqual(invalidRegistry.packages[0].plugin, undefined)
    assert.strictEqual(nullRegistry.packages[0].plugin, undefined)
    assert.strictEqual(malformedRegistry.packages[0].plugin, undefined)
    assert.strictEqual(replacedRegistry.packages[0].plugin, undefined)
  })

  it('maps every component of a composite integration', () => {
    const packet = inspect(runRepositoryTool, 'amqplib', ['--traits', 'producer'])

    assert.deepStrictEqual(packet.targets.plugins, [
      'packages/datadog-plugin-amqplib/src/client.js',
      'packages/datadog-plugin-amqplib/src/consumer.js',
      'packages/datadog-plugin-amqplib/src/index.js',
      'packages/datadog-plugin-amqplib/src/producer.js',
      'packages/datadog-plugin-amqplib/src/util.js',
    ])
    assert.strictEqual(packet.evidence.contractSources.includes('packages/dd-trace/src/plugins/client.js'), true)
    assert.strictEqual(packet.evidence.contractSources.includes('packages/dd-trace/src/plugins/consumer.js'), true)
    assert.strictEqual(packet.evidence.contractSources.includes('packages/dd-trace/src/plugins/producer.js'), true)
    assert.strictEqual(Object.hasOwn(packet, 'contract'), false)
  })

  it('derives scoped package registrations from their canonical registries', () => {
    const packet = inspect(runRepositoryTool, 'google-cloud-pubsub')

    const packageRegistration = packet.packages.find(({ name }) => name === '@google-cloud/pubsub')
    assert.notStrictEqual(packageRegistration, undefined)
    assert.match(packageRegistration.hook, /packages\/datadog-instrumentations\/src\/helpers\/hooks\.js:/)
    assert.match(packageRegistration.plugin, /packages\/dd-trace\/src\/plugins\/index\.js:/)
    const versions = JSON.parse(readFileSync(
      join(repositoryDirectory, 'packages/dd-trace/test/plugins/versions/package.json'),
      'utf8'
    ))
    assert.strictEqual(packageRegistration.version.value, versions.dependencies['@google-cloud/pubsub'])
  })

  it('follows package registration into a differently named plugin', () => {
    const packet = inspect(runRepositoryTool, 'mongodb')

    const packageRegistration = packet.packages.find(({ name }) => name === 'mongodb')
    assert.match(packageRegistration.plugin, /packages\/dd-trace\/src\/plugins\/index\.js:/)
    assert.strictEqual(
      packet.targets.plugins.includes('packages/datadog-plugin-mongodb-core/src/index.js'),
      true
    )
    assert.strictEqual(
      packet.targets.tests.includes('packages/datadog-plugin-mongodb-core/test/mongodb.spec.js'),
      true
    )
    assert.strictEqual(
      packet.evidence.contractSources.includes('packages/dd-trace/src/plugins/database.js'),
      true
    )
    for (const name of ['types', 'v5Types', 'docs', 'docsTest', 'workflows']) {
      assert.notStrictEqual(packet.registrations[name].length, 0, `${name} should resolve through mongodb-core`)
    }
  })

  it('derives naming schemas from their complete coordinates', () => {
    const awsSchemas = inspect(runRepositoryTool, 'aws-sdk').registrations.schemas
    const apolloSchemas = inspect(runRepositoryTool, 'apollo').registrations.schemas
    const graphqlSchemas = inspect(runRepositoryTool, 'graphql').registrations.schemas
    const cosmosSchemas = inspect(runRepositoryTool, 'azure-cosmos').registrations.schemas

    assert.deepStrictEqual(new Set(awsSchemas.map(source => source.replace(/:\d+$/, ''))), new Set([
      'packages/dd-trace/src/service-naming/schemas/v0/messaging.js',
      'packages/dd-trace/src/service-naming/schemas/v0/web.js',
      'packages/dd-trace/src/service-naming/schemas/v1/messaging.js',
      'packages/dd-trace/src/service-naming/schemas/v1/web.js',
    ]))
    assert.strictEqual(apolloSchemas.length, 12)
    assert.deepStrictEqual(new Set(apolloSchemas.map(source => source.replace(/:\d+$/, ''))), new Set([
      'packages/dd-trace/src/service-naming/schemas/v0/web.js',
      'packages/dd-trace/src/service-naming/schemas/v1/web.js',
    ]))
    assert.strictEqual(graphqlSchemas.length, 4)
    assert.deepStrictEqual(new Set(graphqlSchemas.map(source => source.replace(/:\d+$/, ''))), new Set([
      'packages/dd-trace/src/service-naming/schemas/v0/graphql.js',
      'packages/dd-trace/src/service-naming/schemas/v1/graphql.js',
    ]))
    assert.deepStrictEqual(cosmosSchemas, [])
  })

  it('uses an ordinary shimmer integration as the closest reference', () => {
    const reference = inspect(runRepositoryTool, 'new-plugin', ['--traits', 'shimmer,cache']).reference

    assert.strictEqual(reference.integration, 'ioredis')
    assert.strictEqual(reference.files.includes('packages/datadog-instrumentations/src/ioredis.js'), true)
  })

  it('keeps package linkage narrow when an instrumentation uses a shared plugin', () => {
    const packet = inspect(runRepositoryTool, 'webdriverio')

    assert.deepStrictEqual(
      packet.packages.map(({ name }) => name),
      ['@wdio/cli', '@wdio/jasmine-framework', '@wdio/local-runner', '@wdio/utils']
    )
    assert.strictEqual(packet.packages[0].plugin, undefined)
    assert.match(packet.packages[1].plugin, /packages\/dd-trace\/src\/plugins\/index\.js:/)
    assert.match(packet.packages[2].plugin, /packages\/dd-trace\/src\/plugins\/index\.js:/)
    assert.strictEqual(packet.packages[3].plugin, undefined)
    assert.deepStrictEqual(packet.targets.plugins, ['packages/datadog-plugin-mocha/src/index.js'])
    assert.strictEqual(
      packet.evidence.contractSources.includes('packages/dd-trace/src/plugins/ci_plugin.js'),
      true
    )
    const instrumentation = 'packages/datadog-instrumentations/src/webdriverio.js'
    const source = readFileSync(join(repositoryDirectory, instrumentation), 'utf8')
    const lines = source.split('\n')
    let subscriptionCount = 0
    for (let i = 0; i < lines.length; i++) {
      if (/\.subscribe\s*\(/.test(lines[i])) {
        subscriptionCount++
        assert.strictEqual(packet.evidence.channelAnchors.includes(`${instrumentation}:${i + 1}`), true)
      }
    }
    assert.notStrictEqual(subscriptionCount, 0)
  })

  it('keeps integration-specific tests when production uses a shared plugin', () => {
    const packet = inspect(runRepositoryTool, 'mercurius')

    assert.strictEqual(
      packet.targets.plugins.includes('packages/datadog-plugin-graphql/src/index.js'),
      true
    )
    assert.strictEqual(
      packet.targets.tests.includes('packages/datadog-plugin-graphql/test/index.spec.js'),
      true
    )
    assert.strictEqual(
      packet.targets.tests.includes('packages/datadog-plugin-mercurius/test/index.spec.js'),
      true
    )
    assert.strictEqual(
      packet.targets.dependents.includes('packages/datadog-plugin-apollo/src/gateway/request.js'),
      true
    )
    const execute = 'packages/datadog-plugin-graphql/src/execute.js'
    const source = readFileSync(join(repositoryDirectory, execute), 'utf8')
    const line = source.split('\n').findIndex(line => /\.addTraceSubs\s*\(/.test(line)) + 1
    assert.notStrictEqual(line, 0)
    assert.strictEqual(packet.evidence.channelAnchors.includes(`${execute}:${line}`), true)
  })

  it('maps manual subscriptions and cross-plugin dependents', () => {
    const packet = inspect(runRepositoryTool, 'google-cloud-pubsub', ['--mode', 'serverless'])

    const pushSubscription = 'packages/datadog-plugin-google-cloud-pubsub/src/pubsub-push-subscription.js'
    const source = readFileSync(join(repositoryDirectory, pushSubscription), 'utf8')
    const subscriptionCount = source.split('\n').filter(line => /\.addSub\s*\(/.test(line)).length
    const anchors = packet.evidence.channelAnchors.filter(anchor => anchor.startsWith(`${pushSubscription}:`))
    assert.strictEqual(
      packet.targets.dependents.includes('packages/datadog-plugin-http/src/index.js'),
      true
    )
    assert.notStrictEqual(subscriptionCount, 0)
    assert.strictEqual(anchors.length, subscriptionCount)

    const rendered = runRepositoryTool(['--inspect', 'google-cloud-pubsub', '--mode', 'serverless'])
    assert.strictEqual(rendered.status, 0)
    assert.match(rendered.stdout, /^ {2}packages\/datadog-plugin-http\/src\/index\.js$/m)
  })

  it('routes router integrations through their actual contract sources', () => {
    const packet = inspect(runRepositoryTool, 'express', ['--traits', 'router'])

    assert.strictEqual(
      packet.evidence.contractSources.includes('packages/datadog-plugin-router/src/index.js'),
      true
    )
    assert.strictEqual(
      packet.evidence.contractSources.includes('packages/datadog-plugin-web/src/index.js'),
      true
    )
    const router = 'packages/datadog-plugin-router/src/index.js'
    const source = readFileSync(join(repositoryDirectory, router), 'utf8')
    const subscriptionCount = source.split('\n').filter(line => /\.addSub\s*\(/.test(line)).length
    const anchors = packet.evidence.channelAnchors.filter(anchor => anchor.startsWith(`${router}:`))
    assert.notStrictEqual(subscriptionCount, 0)
    assert.strictEqual(anchors.length, subscriptionCount)

    const plugin = 'packages/dd-trace/src/plugins/plugin.js'
    const pluginLines = readFileSync(join(repositoryDirectory, plugin), 'utf8').split('\n')
    let lifecycleCount = 0
    for (let i = 0; i < pluginLines.length; i++) {
      if (!pluginLines[i].trimStart().startsWith('//') &&
          /\.(?:bindStore|subscribe|unbindStore|unsubscribe)\s*\(/.test(pluginLines[i])) {
        lifecycleCount++
        assert.strictEqual(packet.evidence.channelAnchors.includes(`${plugin}:${i + 1}`), true)
      }
    }
    assert.notStrictEqual(lifecycleCount, 0)
  })

  it('does not replace plugin overrides with inherited defaults', () => {
    const packet = inspect(runRepositoryTool, 'aerospike')

    assert.strictEqual(
      packet.targets.plugins.includes('packages/datadog-plugin-aerospike/src/index.js'),
      true
    )
    assert.strictEqual(
      packet.evidence.contractSources.includes('packages/dd-trace/src/plugins/database.js'),
      true
    )
    assert.strictEqual(Object.hasOwn(packet, 'contract'), false)
  })

  it('rejects stale discovery metadata', () => {
    const { status, stderr } = runTool([], (root) => {
      writeFixtureFile(root, '.agents/skills/apm-integrations/agents/openai.yaml', `interface:
  display_name: "APM integrations"
  short_description: "Build integrations"
  default_prompt: "Review this integration."
`)
    })

    assert.strictEqual(status, 1)
    assert.match(stderr, /default_prompt must mention \$apm-integrations/)
  })

  it('rejects malformed and incomplete discovery metadata', () => {
    const malformed = runTool([], (root) => {
      writeFixtureFile(root, '.agents/skills/apm-integrations/agents/openai.yaml', 'interface: [\n')
    })
    const incomplete = runTool([], (root) => {
      writeFixtureFile(root, '.agents/skills/apm-integrations/agents/openai.yaml', '{}\n')
    })

    assert.strictEqual(malformed.status, 1)
    assert.match(malformed.stderr, /invalid YAML/)
    assert.strictEqual(incomplete.status, 1)
    assert.match(incomplete.stderr, /missing interface\.display_name/)
  })
})
