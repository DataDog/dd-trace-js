'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const { describe, it } = require('mocha')

const REPOSITORY_ROOT = path.resolve(__dirname, '../../../..')

function repositoryFiles () {
  return execFileSync('git', ['ls-files', '-z'], { cwd: REPOSITORY_ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .map(file => path.join(REPOSITORY_ROOT, file))
}

function skillFiles (files) {
  const skillDirectories = new Set(
    files.filter(file => path.basename(file) === 'SKILL.md').map(file => path.dirname(file))
  )

  return files.filter(file => {
    return file.endsWith('.md') && [...skillDirectories].some(directory => file.startsWith(`${directory}${path.sep}`))
  })
}

function codeSpans (source) {
  return [...source.matchAll(/`([^`\n]+)`/g)].map(([, span]) => span)
}

function markdownLinks (source) {
  return [...source.matchAll(/\]\(([^\s)#]+)(?:#[^)]+)?\)/g)].map(([, destination]) => destination)
}

function isTemplate (value) {
  return /[<{]|\$\{|…/.test(value)
}

function isRepositoryPath (value) {
  if (!value.includes('/') || /[\s:]/.test(value) || value.startsWith('@')) return false

  if (path.posix.isAbsolute(value)) return value.startsWith(`${REPOSITORY_ROOT}/`)

  if (!value.startsWith('.') && !value.endsWith('/') && !value.split('/').some(segment => path.posix.extname(segment))) {
    return false
  }

  return value.startsWith('./') || value.startsWith('../') || fs.existsSync(path.join(REPOSITORY_ROOT, value.split('/')[0]))
}

function isRepositoryLink (value) {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) return false

  return value.startsWith('.') || value.includes('/') || Boolean(path.posix.extname(value))
}

function pathExists (candidate) {
  return fs.existsSync(candidate) || fs.existsSync(`${candidate}.js`) || fs.existsSync(path.join(candidate, 'index.js'))
}

function pathVariants (reference) {
  const relative = path.posix.normalize(reference).replace(/^(?:\.\.\/|\.\/)+/, '')
  return [relative, `${relative}.js`, `${relative}/index.js`]
}

function pathMatches (reference, candidate) {
  const pattern = reference
    .replaceAll('**', '\u0000')
    .replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
    .replaceAll('*', '[^/]*')
    .replaceAll('\u0000', '.*')

  return new RegExp(`(?:^|/)${pattern}$`).test(candidate)
}

function referencedPathExists (reference, files) {
  const variants = pathVariants(reference)

  return variants.some(variant => {
    if (pathExists(path.join(REPOSITORY_ROOT, variant))) return true

    return files.some(file => {
      const relative = path.relative(REPOSITORY_ROOT, file).split(path.sep).join('/')
      return pathMatches(variant, relative)
    })
  })
}

function classDefinitions (files) {
  const definitions = new Set()

  for (const file of files) {
    if (!file.endsWith('.js')) continue

    const source = fs.readFileSync(file, 'utf8')
    for (const [, className] of source.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)\b/g)) {
      definitions.add(className)
    }
  }

  return definitions
}

function pluginClasses (source) {
  return new Set(codeSpans(source).flatMap(span => {
    if (isTemplate(span)) return []

    return span.match(/\b[A-Z][A-Za-z0-9]*Plugin\b/g) ?? []
  }))
}

describe('skill references', () => {
  const files = repositoryFiles()
  const skills = skillFiles(files)

  it('discovers every repository skill', () => {
    assert.ok(skills.length > 0, 'expected at least one SKILL.md in the repository')
  })

  it('references existing repository paths and links', () => {
    for (const file of skills) {
      const source = fs.readFileSync(file, 'utf8')

      for (const destination of markdownLinks(source)) {
        if (isTemplate(destination) || !isRepositoryLink(destination)) continue

        assert.ok(
          pathExists(path.resolve(path.dirname(file), destination)),
          `${path.relative(REPOSITORY_ROOT, file)} links to missing path \`${destination}\``
        )
      }

      for (const span of codeSpans(source)) {
        if (isTemplate(span) || !isRepositoryPath(span)) continue

        assert.ok(
          referencedPathExists(span, files),
          `${path.relative(REPOSITORY_ROOT, file)} references missing path \`${span}\``
        )
      }
    }
  })

  it('references existing plugin classes', () => {
    const definitions = classDefinitions(files)

    for (const file of skills) {
      const source = fs.readFileSync(file, 'utf8')
      for (const className of pluginClasses(source)) {
        assert.ok(definitions.has(className), `${path.relative(REPOSITORY_ROOT, file)} references missing class \`${className}\``)
      }
    }
  })
})
