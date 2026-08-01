import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
  'packages/datadog-instrumentations/src/helpers/hooks.js': `esmFirst: true
serverless: false
'fixture-package-extra': () => require('../fixture-extra')
'fixture-package': () => require('../fixture')
`,
  'packages/datadog-instrumentations/src/fixture.js': 'module.exports = {}\n',
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
  'packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/index.js': 'module.exports = {}\n',
  'packages/datadog-plugin-fixture/src/helper.js': 'module.exports = {}\n',
  'packages/datadog-plugin-fixture/src/README.md': '# Fixture\n',
  'packages/datadog-plugin-fixture/src/index.js': `const CachePlugin = require('../../dd-trace/src/plugins/cache')
class FixturePlugin extends CachePlugin {}
module.exports = FixturePlugin
`,
  'packages/datadog-plugin-fixture/test/index.spec.js': 'describe(\'fixture\', () => {})\n',
  'packages/datadog-plugin-fixture/test/nested/esm.spec.mjs': 'describe(\'fixture esm\', () => {})\n',
  'packages/datadog-plugin-derived/src/index.js': `const DatabasePlugin = require('../../dd-trace/src/plugins/database')
class DerivedPlugin extends DatabasePlugin {}
module.exports = DerivedPlugin
`,
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
  get fixture () { return require('../../../datadog-plugin-fixture/src') },
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

    const commandArguments = args.length === 0 ? [verifierPath, root] : [verifierPath, ...args, '--root', root]
    const { status, stdout, stderr } = spawnSync(process.execPath, commandArguments, { encoding: 'utf8' })
    return { status, stdout, stderr }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
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
    const { status, stdout } = runTool([
      '--inspect',
      'fixture',
      '--package',
      'fixture-package',
      '--mode',
      'review',
      '--traits',
      'auto,cjs-esm,cache',
      '--json',
    ])

    assert.strictEqual(status, 0)
    const packet = JSON.parse(stdout)
    assert.strictEqual(packet.integration, 'fixture')
    assert.strictEqual(packet.package, 'fixture-package')
    assert.strictEqual(packet.mode, 'review')
    assert.deepStrictEqual(packet.traits, ['auto', 'cjs-esm', 'cache'])
    assert.strictEqual(packet.targets.instrumentation, 'packages/datadog-instrumentations/src/fixture.js')
    assert.strictEqual(
      packet.targets.rewriter,
      'packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/fixture.js'
    )
    assert.strictEqual(packet.contract.pluginBase, 'cache')
    assert.strictEqual(packet.contract.requestedBase, 'cache')
    assert.strictEqual(packet.contract.startSpan, 'startSpan(options, ctx)')
    assert.strictEqual(packet.contract.type, 'storage')
    assert.strictEqual(packet.contract.kind, 'client')
    assert.strictEqual(packet.contract.operation, 'command')
    assert.deepStrictEqual(packet.contract.schemas, [
      'packages/dd-trace/src/service-naming/schemas/v0/storage.js',
      'packages/dd-trace/src/service-naming/schemas/v1/storage.js',
    ])
    assert.deepStrictEqual(packet.contract.channels, ['Client_run'])
    assert.deepStrictEqual(packet.registrations, {
      hook: true,
      plugin: true,
      latestVersion: '1.0.0',
      types: true,
      v5Types: true,
      docs: true,
      docsTest: true,
      codeowners: '/packages/datadog-plugin-fixture/',
      workflow: true,
    })
    assert.strictEqual(packet.targets.tests.length, 2)
    assert.match(packet.registrations.codeowners, /datadog-plugin-fixture/)
    assert.strictEqual(packet.reference, undefined)
    assert.deepStrictEqual(packet.references, [
      '.agents/skills/apm-integrations/references/orchestrion.md',
      'packages/dd-trace/src/plugins/cache.js',
      '.agents/skills/apm-integrations/references/testing.md',
    ])
  })

  it('keeps an absent integration actionable for add mode', () => {
    const { status, stdout } = runTool([
      '--inspect',
      'new-plugin',
      '--mode',
      'add',
      '--traits',
      'orchestrion,auto,async,cjs-esm,cache',
      '--json',
    ])

    assert.strictEqual(status, 0)
    const packet = JSON.parse(stdout)
    assert.strictEqual(packet.targets.plugin, undefined)
    assert.strictEqual(packet.registrations.hook, false)
    assert.strictEqual(packet.registrations.plugin, false)
    assert.deepStrictEqual(packet.reference, {
      integration: 'fixture',
      files: [
        'packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/fixture.js',
        'packages/datadog-instrumentations/src/fixture.js',
        'packages/datadog-plugin-fixture/src/index.js',
        'packages/datadog-plugin-fixture/test/index.spec.js',
      ],
      registrations: [
        'packages/datadog-instrumentations/src/helpers/hooks.js:4',
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

  it('rejects missing and invalid CLI values', () => {
    const underscore = runTool(['--inspect', 'child_process', '--json'])
    const cases = [
      [['--inspect'], /--inspect requires an integration id/],
      [['--inspect', 'fixture', '--package'], /--package requires an npm package name/],
      [['--inspect', 'fixture', '--traits'], /--traits requires a comma-separated value/],
      [['--inspect', 'fixture', '--traits', 'invent'], /unknown integration trait: invent/],
      [['--inspect', 'fixture', '--root'], /--root requires a directory/],
      [['--inspect', 'fixture', '--unknown'], /unknown option: --unknown/],
      [['--inspect', 'fixture', 'extra'], /unexpected argument: extra/],
      [['--inspect', '../fixture'], /integration id must contain only lowercase letters/],
    ]

    assert.strictEqual(underscore.status, 0)
    for (const [args, expected] of cases) {
      const { status, stderr } = spawnSync(process.execPath, [verifierPath, ...args], { encoding: 'utf8' })
      assert.strictEqual(status, 1)
      assert.match(stderr, expected)
    }
  })

  it('does not infer registration from a prefix sibling', () => {
    const { status, stdout } = runTool(['--inspect', 'fix', '--json'])

    assert.strictEqual(status, 0)
    const packet = JSON.parse(stdout)
    assert.strictEqual(packet.registrations.plugin, false)
    assert.strictEqual(packet.registrations.codeowners, undefined)
    assert.strictEqual(packet.registrations.workflow, false)
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
    assert.match(stdout, /^Integration: fixture \(fixture\)$/m)
    assert.match(stdout, /^ {2}base: cache$/m)
    assert.match(stdout, /references\/shimmer\.md/)
    assert.strictEqual(missing.status, 0)
    assert.match(missing.stdout, /^Mode: review; traits: cache, auto$/m)
    assert.match(missing.stdout, /^ {2}instrumentation: missing$/m)
    assert.match(missing.stdout, /^ {2}rewriter: missing$/m)
    assert.match(missing.stdout, /^ {2}plugin: missing$/m)
    assert.match(missing.stdout, /^ {2}base: cache \(requested\)$/m)
    assert.match(missing.stdout, /^ {2}startSpan: startSpan\(options, ctx\)$/m)
    assert.match(missing.stdout, /^ {2}role: storage\/client\/command$/m)
    assert.match(missing.stdout, /^ {2}schemas: packages\/dd-trace\/src\/service-naming\/schemas\/v0\/storage\.js, /m)
    assert.match(missing.stdout, /^ {2}channels: unresolved$/m)
    assert.match(missing.stdout, /^Closest current reference: fixture$/m)
    assert.strictEqual(noTraits.status, 0)
    assert.match(noTraits.stdout, /^Mode: review$/m)
    assert.match(noTraits.stdout, /^ {2}base: unresolved$/m)
    assert.match(noTraits.stdout, /^ {2}startSpan: unresolved$/m)
  })

  it('routes serverless proof without APM reference noise', () => {
    const { status, stdout } = runTool([
      '--inspect',
      'fixture',
      '--mode',
      'serverless',
      '--json',
    ], (root) => {
      rmSync(join(root, '.github/workflows/apm-integrations.yml'))
      writeFixtureFile(root, '.github/workflows/serverless.yml', 'PLUGINS: other|fixture\n')
    })

    assert.strictEqual(status, 0)
    const packet = JSON.parse(stdout)
    assert.strictEqual(packet.registrations.workflow, true)
    assert.deepStrictEqual(packet.references, [
      '.agents/skills/apm-integrations/references/orchestrion.md',
      '.agents/skills/serverless-integrations/references/testing-guide.md',
    ])
  })

  it('resolves inherited plugin base contracts', () => {
    const { status, stdout } = runTool(['--inspect', 'derived', '--json'])
    const missingBase = runTool(['--inspect', 'derived', '--json'], (root) => {
      rmSync(join(root, 'packages/dd-trace/src/plugins/database.js'))
    })

    assert.strictEqual(status, 0)
    const packet = JSON.parse(stdout)
    assert.strictEqual(packet.contract.pluginBase, 'database')
    assert.strictEqual(packet.contract.startSpan, 'startSpan(name, options, ctx)')
    assert.strictEqual(packet.contract.type, 'storage')
    assert.strictEqual(packet.contract.kind, 'client')
    assert.strictEqual(missingBase.status, 0)
    assert.strictEqual(JSON.parse(missingBase.stdout).contract.startSpan, undefined)
  })

  it('reports unavailable optional evidence without failing', () => {
    const { status, stdout } = runTool(['--inspect', 'fixture', '--json'], (root) => {
      rmSync(join(root, 'docs/test.ts'))
      rmSync(join(root, '.github/CODEOWNERS'))
      rmSync(join(root, 'packages/dd-trace/test/plugins/versions/package.json'))
    })
    const noDependencies = runTool(['--inspect', 'fixture', '--json'], (root) => {
      writeFixtureFile(root, 'packages/dd-trace/test/plugins/versions/package.json', '{}')
    })
    const fallbackTest = runTool([
      '--inspect',
      'new-plugin',
      '--traits',
      'cache,auto',
      '--json',
    ], (root) => {
      rmSync(join(root, 'packages/datadog-plugin-fixture/test/index.spec.js'))
      rmSync(join(root, 'index.d.v5.ts'))
      rmSync(join(root, '.github/workflows/serverless.yml'))
    })

    assert.strictEqual(status, 0)
    const packet = JSON.parse(stdout)
    assert.strictEqual(packet.registrations.latestVersion, undefined)
    assert.strictEqual(packet.registrations.docsTest, false)
    assert.strictEqual(packet.registrations.codeowners, undefined)
    assert.strictEqual(noDependencies.status, 0)
    assert.strictEqual(JSON.parse(noDependencies.stdout).registrations.latestVersion, undefined)
    assert.strictEqual(fallbackTest.status, 0)
    assert.strictEqual(
      JSON.parse(fallbackTest.stdout).reference.files.at(-1),
      'packages/datadog-plugin-fixture/test/nested/esm.spec.mjs'
    )
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
