'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { describe, it } = require('mocha')

const REPOSITORY_ROOT = path.resolve(__dirname, '../../../..')
const SKILL_DIRECTORIES = [
  '.agents/skills/apm-integrations',
  '.agents/skills/llmobs-integration',
]
const REPOSITORY_PATH_PREFIXES = [
  '.github/',
  'docs/',
  'integration-tests/',
  'packages/',
  'scripts/',
  'vendor/',
  'versions/',
]
const ROOT_PATHS = new Set([
  'AGENTS.md',
  'CONTRIBUTING.md',
  'docker-compose.yml',
  'index.d.ts',
  'package.json',
])
const RELATIVE_IMPORT_BASES = [
  'packages/datadog-plugin-example/src',
  'packages/datadog-plugin-example/test',
  'packages/datadog-plugin-example/test/integration-test',
]
const SHORT_PATH_BASES = {
  'ai/': ['packages/dd-trace/src/llmobs/plugins'],
  'anthropic/': ['packages/dd-trace/src/llmobs/plugins'],
  'genai/': ['packages/dd-trace/src/llmobs/plugins'],
  'helpers/': ['packages/datadog-instrumentations/src'],
  'openai/': ['packages/dd-trace/src/llmobs/plugins'],
  'plugins/test': ['.github/actions'],
  'rewriter/': ['packages/datadog-instrumentations/src/helpers'],
  'src/': [
    'packages/datadog-instrumentations',
    'packages/datadog-plugin-langchain',
    'packages/datadog-plugin-langgraph',
  ],
}

function markdownFiles (directory) {
  return fs.readdirSync(path.join(REPOSITORY_ROOT, directory), { recursive: true })
    .filter(file => file.endsWith('.md'))
    .map(file => path.join(directory, file))
}

function codeSpans (source) {
  return [...source.matchAll(/`([^`\n]+)`/g)].map(([, span]) => span)
}

function markdownLinks (source) {
  return [...source.matchAll(/\]\(([^\s)#]+)(?:#[^)]+)?\)/g)].map(([, destination]) => destination)
}

function isTemplate (value) {
  return /[<{]|\$\{/.test(value)
}

function repositoryPath (value) {
  return ROOT_PATHS.has(value) || REPOSITORY_PATH_PREFIXES.some(prefix => value.startsWith(prefix))
}

function pathExists (candidate) {
  return fs.existsSync(candidate) || fs.existsSync(`${candidate}.js`) || fs.existsSync(path.join(candidate, 'index.js'))
}

function shortPathExists (span) {
  for (const [prefix, bases] of Object.entries(SHORT_PATH_BASES)) {
    if (!span.startsWith(prefix)) continue

    return bases.some(base => pathExists(path.join(REPOSITORY_ROOT, base, span)))
  }
  return undefined
}

function classDefinitions () {
  const definitions = new Set()
  const packages = path.join(REPOSITORY_ROOT, 'packages')

  for (const file of fs.readdirSync(packages, { recursive: true })) {
    if (!file.endsWith('.js') || file.includes('/node_modules/')) continue

    const source = fs.readFileSync(path.join(packages, file), 'utf8')
    for (const [, className] of source.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)\b/g)) {
      definitions.add(className)
    }
  }

  return definitions
}

describe('integration skill references', () => {
  const files = SKILL_DIRECTORIES.flatMap(markdownFiles)

  it('references existing repository paths, links, and relative imports', () => {
    for (const file of files) {
      const source = fs.readFileSync(path.join(REPOSITORY_ROOT, file), 'utf8')

      for (const destination of markdownLinks(source)) {
        if (isTemplate(destination) || destination.startsWith('http://') || destination.startsWith('https://')) continue

        assert.ok(
          pathExists(path.resolve(REPOSITORY_ROOT, path.dirname(file), destination)),
          `${file} links to missing path \`${destination}\``
        )
      }

      for (const span of codeSpans(source)) {
        if (isTemplate(span)) continue

        if (repositoryPath(span)) {
          assert.ok(pathExists(path.join(REPOSITORY_ROOT, span)), `${file} references missing path \`${span}\``)
          continue
        }

        if (span.startsWith('../')) {
          const exists = RELATIVE_IMPORT_BASES.some(base => pathExists(path.resolve(REPOSITORY_ROOT, base, span)))
          assert.ok(exists, `${file} references missing relative import \`${span}\``)
          continue
        }

        const exists = shortPathExists(span)
        if (exists !== undefined) {
          assert.ok(exists, `${file} references missing short path \`${span}\``)
        }
      }
    }
  })

  it('references existing plugin classes', () => {
    const definitions = classDefinitions()

    for (const file of files) {
      const source = fs.readFileSync(path.join(REPOSITORY_ROOT, file), 'utf8')
      const classes = new Set(source.match(/\b[A-Z][A-Za-z0-9]*Plugin\b/g) ?? [])

      classes.add('Plugin')
      classes.delete('MyPlugin') // Template class used in implementation examples.
      for (const className of classes) {
        assert.ok(definitions.has(className), `${file} references missing class \`${className}\``)
      }
    }
  })
})
