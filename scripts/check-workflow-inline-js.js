#!/usr/bin/env node

'use strict'

/* eslint-disable no-console */

const { readdirSync, readFileSync } = require('node:fs')
const { join, relative } = require('node:path')

const YAML = require('yaml')

const MAX_LINES = 5

// Whitespace between shell words, including a backslash line continuation. The continuation comes first so a
// match never stops at the backslash.
const CONTINUATION = String.raw`[ \t]*\\\n\s*`
const SPACE = String.raw`(?:${CONTINUATION}|[ \t]+)`
const NODE_EVAL = new RegExp(
  String.raw`\bnode${SPACE}(?:[^\s;&|<>]+${SPACE})*?(?:-e|--eval|-p|--print)(?:=|${CONTINUATION}|[ \t]+)`,
  'g'
)
const NODE_HEREDOC = /\bnode\b[^\n]*?<<-?[ \t]*(['"]?)([^\s'"]+)\1/g

/**
 * @param {string} directory
 * @returns {string[]}
 */
function findYamlFiles (directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...findYamlFiles(path))
    } else if (entry.name.endsWith('.yml') || entry.name.endsWith('.yaml')) {
      files.push(path)
    }
  }
  return files
}

/**
 * @param {string} source
 */
function countLines (source) {
  const trimmed = source.trim()
  return trimmed === '' ? 0 : trimmed.split('\n').length
}

/**
 * Reads the shell word that starts at `start`, honoring single, double and `$'...'` quotes.
 *
 * @param {string} script
 * @param {number} start
 */
function readShellWord (script, start) {
  const ansiC = script.startsWith("$'", start)
  if (ansiC) start++
  const quote = script[start]
  if (quote !== '"' && quote !== "'") {
    const end = script.slice(start).search(/[\s;&|]/)
    return end === -1 ? script.slice(start) : script.slice(start, start + end)
  }
  for (let index = start + 1; index < script.length; index++) {
    if ((quote === '"' || ansiC) && script[index] === '\\') {
      index++
    } else if (script[index] === quote) {
      return script.slice(start + 1, index)
    }
  }
  return script.slice(start + 1)
}

/**
 * Finds JavaScript passed to `node` inside a shell script, either as an eval argument or as a heredoc.
 *
 * @param {string} script
 * @returns {{ offset: number, lines: number }[]}
 */
function findInlineNodeScripts (script) {
  const found = []

  for (const match of script.matchAll(NODE_EVAL)) {
    const start = match.index + match[0].length
    found.push({ offset: match.index, lines: countLines(readShellWord(script, start)) })
  }

  for (const match of script.matchAll(NODE_HEREDOC)) {
    const [, , delimiter] = match
    const bodyStart = script.indexOf('\n', match.index) + 1
    const body = bodyStart === 0 ? [] : script.slice(bodyStart).split('\n')
    const end = body.findIndex(line => line.replace(/^\t*/, '').trimEnd() === delimiter)
    found.push({ offset: match.index, lines: countLines((end === -1 ? body : body.slice(0, end)).join('\n')) })
  }

  return found
}

/**
 * @param {YAML.Scalar} node
 * @param {YAML.LineCounter} lineCounter
 * @param {number} [offset]
 */
function lineOf (node, lineCounter, offset = 0) {
  // Block scalars start on the line after their indicator, so skip ahead to the value itself.
  const [start] = node.range ?? [0]
  const isBlock = node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED'
  const linesBefore = String(node.value).slice(0, offset).split('\n').length - 1
  return lineCounter.linePos(start).line + (isBlock ? 1 : 0) + linesBefore
}

/**
 * @param {string} file
 * @param {string} source
 * @returns {string[]}
 */
function checkSource (file, source) {
  const lineCounter = new YAML.LineCounter()
  const document = YAML.parseDocument(source, { lineCounter })
  const errors = []

  /**
   * @param {YAML.Scalar} node
   * @param {number} lines
   * @param {string} kind
   * @param {number} [offset]
   */
  const report = (node, lines, kind, offset) => {
    if (lines <= MAX_LINES) return
    errors.push(`${file}:${lineOf(node, lineCounter, offset)}: ${kind} has ${lines} lines of JavaScript.`)
  }

  YAML.visit(document, {
    Map (_, map) {
      const uses = map.get('uses')
      const run = map.get('run', true)

      if (typeof uses === 'string' && uses.startsWith('actions/github-script@')) {
        const script = map.getIn(['with', 'script'], true)
        if (YAML.isScalar(script)) report(script, countLines(String(script.value)), 'actions/github-script script')
      }

      if (!YAML.isScalar(run) || typeof run.value !== 'string') return

      const shell = map.get('shell')
      if (typeof shell === 'string' && /^node\b/.test(shell)) {
        report(run, countLines(run.value), 'node shell step')
        return
      }

      for (const { offset, lines } of findInlineNodeScripts(run.value)) {
        report(run, lines, 'inline node script', offset)
      }
    },
  })

  return errors
}

const root = process.cwd()
const errors = []
for (const path of findYamlFiles(join(root, '.github'))) {
  errors.push(...checkSource(relative(root, path), readFileSync(path, 'utf8')))
}

if (errors.length > 0) {
  console.error(errors.join('\n'))
  console.error(
    `Keep JavaScript in GitHub Actions YAML at ${MAX_LINES} lines or fewer. ` +
    'Move longer code into a file under scripts/ and call it from the workflow.'
  )
  process.exitCode = 1
}
