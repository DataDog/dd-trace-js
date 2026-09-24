import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
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
Run \`npm run verify:integration-skills\`.
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
  'package.json': JSON.stringify({ scripts: { 'verify:integration-skills': 'fixture' } }),
  'packages/dd-trace/src/plugins/tracing.js': 'startSpan (name, options = {}, enterOrCtx = true) {}\n',
  'packages/dd-trace/src/plugins/cache.js': 'startSpan (options, ctx) {}\n',
  'packages/dd-trace/src/plugins/producer.js': 'startSpan (options, enterOrCtx) {}\n',
  'packages/dd-trace/src/plugins/consumer.js': 'startSpan (options, enterOrCtx) {}\n',
  'packages/datadog-instrumentations/src/helpers/hooks.js':
    'module.exports = {\n  esmFirst: true,\n  serverless: false,\n}\n',
  'integration-tests/helpers/index.js': "'destructure' | 'direct' | 'namespace'\n",
  'packages/dd-trace/src/lambda/index.js': 'module.exports = {}\n',
  'packages/dd-trace/src/lambda/README.md': '# Lambda\n',
  '.github/CODEOWNERS': `/.agents/skills/apm-integrations/ @DataDog/dd-trace-js @DataDog/apm-idm-js
/.agents/skills/serverless-integrations/ @DataDog/dd-trace-js @DataDog/serverless-aws @DataDog/apm-serverless
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
 */
function writeFixtureFile (root, filename, source) {
  const absoluteFilename = join(root, filename)
  mkdirSync(dirname(absoluteFilename), { recursive: true })
  writeFileSync(absoluteFilename, source)
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
    symlinkSync('../../.agents/skills/apm-integrations', join(claudeSkills, 'apm-integrations'), 'dir')
    symlinkSync('../../.agents/skills/serverless-integrations', join(claudeSkills, 'serverless-integrations'), 'dir')
    const cursorSkills = join(root, '.cursor', 'skills')
    mkdirSync(cursorSkills, { recursive: true })
    symlinkSync('../../.agents/skills/apm-integrations', join(cursorSkills, 'apm-integrations'), 'dir')
    symlinkSync('../../.agents/skills/serverless-integrations', join(cursorSkills, 'serverless-integrations'), 'dir')
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

  it('accepts CRLF skill files', () => {
    const { status, stderr } = runTool([], (root) => {
      for (const [filename, source] of Object.entries(skillFiles)) {
        writeFixtureFile(root, filename, source.replaceAll('\n', '\r\n'))
      }
    })

    assert.strictEqual(status, 0, stderr)
  })

  it('accepts equivalent native discovery link targets', () => {
    const { status, stderr } = runTool([], (root) => {
      for (const client of ['.claude', '.cursor']) {
        for (const skill of ['apm-integrations', 'serverless-integrations']) {
          const link = join(root, client, 'skills', skill)
          rmSync(link)
          symlinkSync(['..', '..', '.agents', '.', 'skills', skill].join(sep), link, 'dir')
        }
      }
    })

    assert.strictEqual(status, 0, stderr)
  })

  it('rejects discovery links to another existing skill', () => {
    const { status, stderr } = runTool([], (root) => {
      for (const client of ['.claude', '.cursor']) {
        for (const skill of ['apm-integrations', 'serverless-integrations']) {
          const link = join(root, client, 'skills', skill)
          const other = skill === 'apm-integrations' ? 'serverless-integrations' : 'apm-integrations'
          rmSync(link)
          symlinkSync(join('..', '..', '.agents', 'skills', other), link, 'dir')
        }
      }
    })

    assert.strictEqual(status, 1)
    for (const client of ['.claude', '.cursor']) {
      for (const skill of ['apm-integrations', 'serverless-integrations']) {
        const expected = `${client}/skills/${skill}: must point to ../../.agents/skills/${skill}`
        assert.strictEqual(stderr.includes(expected), true)
      }
    }
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
      rmSync(join(root, '.cursor/skills/apm-integrations'))
      rmSync(join(root, '.cursor/skills/serverless-integrations'))
      mkdirSync(join(root, '.cursor/skills/serverless-integrations'))
      rmSync(join(root, '.github/CODEOWNERS'))
      rmSync(join(root, 'vendor/package-lock.json'))
    })

    assert.strictEqual(status, 1)
    assert.match(stderr, /missing skill file .*serverless-integrations\/SKILL\.md/)
    assert.match(stderr, /missing source contract file packages\/dd-trace\/src\/plugins\/cache\.js/)
    assert.match(stderr, /missing source contract directory packages\/dd-trace\/src\/lambda/)
    assert.match(stderr, /missing discovery link \.claude\/skills\/apm-integrations/)
    assert.match(stderr, /serverless-integrations: must be a symbolic link/)
    assert.match(stderr, /missing discovery link \.cursor\/skills\/apm-integrations/)
    assert.match(stderr, /\.cursor\/skills\/serverless-integrations: must be a symbolic link/)
    assert.match(stderr, /missing source contract file \.github\/CODEOWNERS/)
    assert.match(stderr, /missing source contract file vendor\/package-lock\.json/)
  })

  it('rejects incomplete skill ownership', () => {
    const { status, stderr } = runTool([], (root) => {
      writeFixtureFile(root, '.github/CODEOWNERS', `/.agents/skills/apm-integrations/ @DataDog/dd-trace-js
/.agents/skills/serverless-integrations/ @DataDog/dd-trace-js @DataDog/apm-serverless
`)
    })

    assert.strictEqual(status, 1)
    assert.match(stderr, /missing APM skill ownership/)
    assert.match(stderr, /missing serverless skill ownership/)
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
