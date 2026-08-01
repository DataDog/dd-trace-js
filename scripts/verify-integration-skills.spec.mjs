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
const sourceFiles = {
  'package.json': JSON.stringify({}),
  'packages/dd-trace/src/plugins/tracing.js': 'startSpan (name, options = {}, enterOrCtx = true) {}\n',
  'packages/dd-trace/src/plugins/cache.js': 'startSpan (options, ctx) {}\n',
  'packages/dd-trace/src/plugins/producer.js': 'startSpan (options, enterOrCtx) {}\n',
  'packages/dd-trace/src/plugins/consumer.js': 'startSpan (options, enterOrCtx) {}\n',
  'packages/datadog-instrumentations/src/helpers/hooks.js': 'esmFirst: true\nserverless: false\n',
  'integration-tests/helpers/index.js': "'destructure' | 'direct' | 'namespace'\n",
  'packages/dd-trace/src/lambda/index.js': 'module.exports = {}\n',
  '.github/CODEOWNERS': `/.agents/skills/apm-integrations/ @DataDog/apm-idm-js
/.agents/skills/serverless-integrations/ @DataDog/serverless-aws @DataDog/apm-serverless
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
function runVerifier (mutate) {
  const root = mkdtempSync(join(tmpdir(), 'dd-integration-skills-'))

  try {
    for (const [filename, source] of Object.entries({ ...skillFiles, ...sourceFiles })) {
      writeFixtureFile(root, filename, source)
    }

    const claudeSkills = join(root, '.claude', 'skills')
    mkdirSync(claudeSkills, { recursive: true })
    symlinkSync('../../.agents/skills/apm-integrations', join(claudeSkills, 'apm-integrations'))
    symlinkSync('../../.agents/skills/serverless-integrations', join(claudeSkills, 'serverless-integrations'))
    mutate?.(root)

    const { status, stdout, stderr } = spawnSync(process.execPath, [verifierPath, root], { encoding: 'utf8' })
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
    const { status, stdout } = runVerifier()

    assert.strictEqual(status, 0)
    assert.match(stdout, /Vendored code transformer: fixture/)
  })

  it('rejects handbook growth outside the reviewed inventory', () => {
    const { status, stderr } = runVerifier((root) => {
      writeFixtureFile(root, '.agents/skills/apm-integrations/references/extra.md', '# Extra\n')
    })

    assert.strictEqual(status, 1)
    assert.match(stderr, /expected exactly these skill files/)
  })

  it('rejects missing skill and source contracts', () => {
    const { status, stderr } = runVerifier((root) => {
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
    const { status, stderr } = runVerifier((root) => {
      const skill = join(root, '.agents/skills/apm-integrations/SKILL.md')
      writeFileSync(skill, '# APM integrations\n')
    })

    assert.strictEqual(status, 1)
    assert.match(stderr, /missing YAML frontmatter/)
  })

  it('rejects stale source paths and contracts', () => {
    const { status, stderr } = runVerifier((root) => {
      const skill = join(root, '.agents/skills/apm-integrations/SKILL.md')
      writeFileSync(skill, `${skillFiles['.agents/skills/apm-integrations/SKILL.md']}\nRead \`packages/missing.js\`.\n`)
      writeFixtureFile(root, 'packages/dd-trace/src/plugins/cache.js', 'startSpan (name, options, ctx) {}\n')
    })

    assert.strictEqual(status, 1)
    assert.match(stderr, /missing referenced path packages\/missing\.js/)
    assert.match(stderr, /CachePlugin\.startSpan signature changed/)
  })

  it('rejects stale npm commands', () => {
    const { status, stderr } = runVerifier((root) => {
      const skill = join(root, '.agents/skills/apm-integrations/SKILL.md')
      writeFileSync(skill, `${skillFiles['.agents/skills/apm-integrations/SKILL.md']}\nRun \`npm run missing\`.\n`)
    })

    assert.strictEqual(status, 1)
    assert.match(stderr, /missing npm script missing/)
  })

  it('rejects an npm command without a package manifest', () => {
    const { status, stderr } = runVerifier((root) => {
      const skill = join(root, '.agents/skills/apm-integrations/SKILL.md')
      writeFileSync(skill, `${skillFiles['.agents/skills/apm-integrations/SKILL.md']}\nRun \`npm run missing\`.\n`)
      rmSync(join(root, 'package.json'))
    })

    assert.strictEqual(status, 1)
    assert.match(stderr, /cannot validate npm commands without package\.json/)
  })

  it('rejects npm commands against an invalid package manifest', () => {
    const { status, stderr } = runVerifier((root) => {
      const skill = join(root, '.agents/skills/apm-integrations/SKILL.md')
      writeFileSync(skill, `${skillFiles['.agents/skills/apm-integrations/SKILL.md']}\nRun \`npm run missing\`.\n`)
      writeFixtureFile(root, 'package.json', '{')
    })

    assert.strictEqual(status, 1)
    assert.match(stderr, /cannot validate npm commands: /)
  })

  it('rejects stored versions', () => {
    const { status, stderr } = runVerifier((root) => {
      const skill = join(root, '.agents/skills/serverless-integrations/SKILL.md')
      writeFileSync(skill, `${skillFiles['.agents/skills/serverless-integrations/SKILL.md']}\nUse version 1.2.3.\n`)
    })

    assert.strictEqual(status, 1)
    assert.match(stderr, /store no version pins; derive them from source/)
  })

  it('reports malformed metadata instead of crashing', () => {
    const { status, stderr } = runVerifier((root) => {
      const skill = join(root, '.agents/skills/apm-integrations/SKILL.md')
      writeFileSync(skill, '---\nname: [\n---\n# Invalid\n')
      writeFixtureFile(root, 'vendor/package-lock.json', '{')
    })

    assert.strictEqual(status, 1)
    assert.match(stderr, /invalid YAML frontmatter/)
    assert.match(stderr, /vendor\/package-lock\.json: invalid JSON/)
  })

  it('rejects a file over its token budget', () => {
    const { status, stderr } = runVerifier((root) => {
      const reference = join(root, '.agents/skills/apm-integrations/references/shimmer.md')
      writeFileSync(reference, `# Shimmer\n${'word '.repeat(300)}`)
    })

    assert.strictEqual(status, 1)
    assert.match(stderr, /shimmer\.md: .* tokens exceeds its 250-token budget/)
  })

  it('rejects invocation span ownership moving into the Lambda bootstrap', () => {
    const { status, stderr } = runVerifier((root) => {
      writeFixtureFile(root, 'packages/dd-trace/src/lambda/index.js', 'tracer.startSpan()\n')
    })

    assert.strictEqual(status, 1)
    assert.match(stderr, /lambda\/index\.js: Lambda now starts a span/)
  })
})
