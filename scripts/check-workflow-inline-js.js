#!/usr/bin/env node

'use strict'

/* eslint-disable no-console */

const { readdirSync, readFileSync } = require('node:fs')
const { join, relative } = require('node:path')

const YAML = require('yaml')

const MAX_LINES = 5

// The eval flags node accepts, either as the whole word or with their code attached after `=`.
const EVAL_FLAG = /^(?:--(?:eval|print)|-[ep])(=|$)/
// A heredoc start, as in `node <<'JS'` or `cat <<'JS' | node`. The heredoc is inline JavaScript when the
// attached command runs node on stdin, or when the rest of the line pipes into a bare `node` command.
const HEREDOC_START = /<<-?[ \t]*(['"]?)([^\s'"]+)\1/g

// Commands that only wrap the command that follows them, so `sudo node` still runs node.
const COMMAND_WRAPPERS = new Set(['command', 'env', 'exec', 'nohup', 'sudo'])

// Node flags that take their value as the next shell word, so that word is not a script argument. The
// eval and print flags are left out on purpose: their value is the program itself, so stdin is data.
const FLAG_VALUES = new Set([
  '--conditions',
  '--cpu-prof-dir',
  '--cpu-prof-interval',
  '--cpu-prof-name',
  '--diagnostic-dir',
  '--dns-result-order',
  '--experimental-loader',
  '--heap-prof-dir',
  '--heap-prof-interval',
  '--heap-prof-name',
  '--import',
  '--input-type',
  '--max-old-space-size',
  '--openssl-config',
  '--redirect-warnings',
  '--require',
  '--snapshot-blob',
  '--stack-size',
  '--stack-trace-limit',
  '--test-reporter-destination',
  '--title',
  '--trace-event-file-pattern',
  '--v8-pool-size',
  '--watch-path',
  '-r',
])

/**
 * Reports whether a shell word after `node` is a flag or a redirection rather than a script argument.
 *
 * @param {string} word
 */
function isFlagOrRedirection (word) {
  return word.startsWith('-') || /^(?:\d*>|<|&>>?)/.test(word)
}

// A redirection written as a bare operator, like `2>`, `&>` or `2>&`, takes its target as the next word.
const REDIRECT_OPERATOR = /^(?:\d*&?>+|\d*>&|<&)$/

/**
 * Reports whether every word is an option, the value of an option that takes one, or a redirection.
 * Anything else, like a script file, is an argument that makes node read its program from a file.
 *
 * @param {string[]} words
 */
function isOptionsOnly (words) {
  for (let index = 0; index < words.length; index++) {
    const word = words[index]
    // A bare redirection operator takes its target as the next word.
    if (REDIRECT_OPERATOR.test(word)) {
      index++
      continue
    }
    if (!isFlagOrRedirection(word)) return false
    // The word after a flag that takes a value is that value, not a script argument.
    if (FLAG_VALUES.has(word)) index++
  }
  return true
}

/**
 * Tokenizes one shell command with the quote-aware reader, skipping environment assignments and
 * wrapper commands like `sudo`, and reports whether it runs `node` with only options left, so its
 * program comes from stdin.
 *
 * @param {string} command
 */
function runsBareNodeCommand (command) {
  const words = []
  let cursor = 0
  for (;;) {
    const word = readWordAt(command, cursor)
    if (word === undefined) break
    words.push(word.text)
    cursor = word.next
  }

  while (words.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || COMMAND_WRAPPERS.has(words[0]))) {
    words.shift()
  }

  return words[0] === 'node' && isOptionsOnly(words.slice(1))
}

/**
 * Reports whether the last command of a shell line runs `node` without a script argument, so its
 * program comes from stdin instead of from a file. Backslash line continuations are joined first, so
 * a command split across lines is still one command.
 *
 * @param {string} line
 */
function runsNodeOnStdin (line) {
  // A heredoc attaches to the last command on the line. A `&` only separates commands when it is
  // not part of a redirection like `2>&1` or `&>`.
  const lastCommand = line.replaceAll(/\\\n\s*/g, ' ').split(/\|\||&&|[;|(]|(?<!>)&(?!>)/).pop()
  return runsBareNodeCommand(lastCommand)
}

/**
 * Reports whether a pipeline segment on the line after a heredoc runs `node` without a script
 * argument, reading the pipe as its program. Only the command right after a pipe reads the pipe;
 * commands after `&&`, `||`, `;` or `&` run separately, and a comment ends the line.
 *
 * @param {string} restOfLine
 */
function pipelineRunsBareNode (restOfLine) {
  return restOfLine.split(/(?<!\|)\|(?!\|)/).some((segment) => {
    const command = segment.split(/&&|\|\||;|(?<=\s)#|(?<!>)&(?!>)/)[0]
    return runsBareNodeCommand(command)
  })
}

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
 * Returns the offset just past the quoted region that starts at `start` with quote `quote`, honoring
 * backslash escapes in double quotes. An unterminated region runs to the end of the script.
 *
 * @param {string} script
 * @param {number} start
 * @param {string} quote
 */
function endOfQuoted (script, start, quote) {
  if (quote === "'") {
    const end = script.indexOf(quote, start + 1)
    return end === -1 ? script.length : end + 1
  }
  for (let index = start + 1; index < script.length; index++) {
    if (script[index] === '\\') {
      index++
    } else if (script[index] === quote) {
      return index + 1
    }
  }
  return script.length
}

/**
 * Reads the shell word that starts at `start`, honoring single, double and `$'...'` quotes and the
 * `@'...'@` and `@"..."@` here-strings of PowerShell. Returns the word and the offset just past it.
 *
 * @param {string} script
 * @param {number} start
 * @returns {{ text: string, next: number }}
 */
function readWord (script, start) {
  const ansiC = script.startsWith("$'", start)
  if (ansiC) start++
  const quote = script[start]

  if (quote === '@' && (script[start + 1] === "'" || script[start + 1] === '"')) {
    // A PowerShell here-string closes with a marker that starts its own line.
    const closer = script[start + 1] === '"' ? '\n"@' : "\n'@"
    const end = script.indexOf(closer, start)
    const bodyStart = script.indexOf('\n', start) + 1
    if (end === -1) return { text: script.slice(bodyStart), next: script.length }
    return { text: script.slice(bodyStart, end), next: end + closer.length }
  }

  if (quote !== '"' && quote !== "'") {
    // A word that does not start with a quote still scans through quoted and escaped regions embedded
    // in it, so an attached option value like `--title='two words'` reads as one word. An `&` that
    // belongs to a redirection, as in `2>&1`, does not end the word either.
    let end = start
    while (end < script.length) {
      const character = script[end]
      if (character === "'" || character === '"') {
        end = endOfQuoted(script, end, character)
      } else if (character === '\\') {
        end += 2
      } else if (/[\s;&|]/.test(character) &&
        !(character === '&' && (/[<>]/.test(script[end - 1]) || script[end + 1] === '>'))) {
        break
      } else {
        end++
      }
    }
    return { text: script.slice(start, end), next: end }
  }
  for (let index = start + 1; index < script.length; index++) {
    if ((quote === '"' || ansiC) && script[index] === '\\') {
      index++
    } else if (script[index] === quote) {
      return { text: script.slice(start + 1, index), next: index + 1 }
    }
  }
  return { text: script.slice(start + 1), next: script.length }
}

/**
 * Reads the next word of the command that continues at `offset`, skipping spaces, tabs and line
 * continuations. Bare newlines and command separators end the command, so the result is `undefined`
 * when no word follows within it.
 *
 * @param {string} script
 * @param {number} offset
 * @returns {{ text: string, start: number, next: number } | undefined}
 */
function readWordAt (script, offset) {
  let start = offset
  for (;;) {
    while (start < script.length && (script[start] === ' ' || script[start] === '\t')) start++
    if (script.startsWith('\\\n', start)) {
      start += 2
      continue
    }
    break
  }
  if (start >= script.length) return
  const first = script[start]
  // An `&` that starts `&>` or `&>>` opens a redirection rather than ending the command.
  if (/[\n;|)]/.test(first) || (first === '&' && script[start + 1] !== '>')) return

  return { ...readWord(script, start), start }
}

/**
 * Finds JavaScript passed to `node` through an eval flag by walking the words after each `node`
 * invocation. The target of a bare redirection operator, the value of an option that takes one, and
 * everything after a script file belong to their word or the script, so the walk skips or stops at
 * them before deciding that a flag is node's eval flag.
 *
 * @param {string} script
 * @returns {{ offset: number, lines: number }[]}
 */
function findEvalScripts (script) {
  const found = []

  for (const match of script.matchAll(/\bnode\b/g)) {
    let cursor = match.index + match[0].length
    for (;;) {
      const word = readWordAt(script, cursor)
      if (word === undefined) break
      cursor = word.next

      // A bare redirection operator and an option that takes a value both own the next word.
      if (REDIRECT_OPERATOR.test(word.text) || FLAG_VALUES.has(word.text)) {
        const target = readWordAt(script, cursor)
        if (target === undefined) break
        cursor = target.next
        continue
      }

      const flag = word.text.match(EVAL_FLAG)
      if (flag) {
        // The code follows the flag as its own word, or is attached after `=`.
        const code = flag[1] === '='
          ? readWord(script, word.start + flag[0].length).text
          : (readWordAt(script, cursor) ?? { text: '' }).text
        found.push({ offset: match.index, lines: countLines(code) })
        break
      }

      // Any other option or redirection keeps the program on stdin. A word that is neither, like a
      // script file, takes over and every later flag belongs to it.
      if (!isFlagOrRedirection(word.text)) break
    }
  }

  return found
}

/**
 * Finds JavaScript passed to `node` inside a shell script: eval arguments and heredocs that node reads
 * or that a pipeline feeds into node.
 *
 * @param {string} script
 * @returns {{ offset: number, lines: number }[]}
 */
function findInlineNodeScripts (script) {
  const found = [...findEvalScripts(script)]

  for (const match of script.matchAll(HEREDOC_START)) {
    const [, , delimiter] = match
    // Follow backslash line continuations backwards so a command split across lines is one command.
    let commandStart = script.lastIndexOf('\n', match.index) + 1
    while (commandStart > 0 && script[commandStart - 2] === '\\') {
      commandStart = script.lastIndexOf('\n', commandStart - 2) + 1
    }
    const lineEnd = script.indexOf('\n', match.index)
    const line = script.slice(commandStart, lineEnd === -1 ? undefined : lineEnd)
    const beforeMarker = line.slice(0, match.index - commandStart)
    const restOfLine = line.slice(match.index - commandStart + match[0].length)

    // A heredoc is inline JavaScript when node reads it as its program, either directly on stdin or
    // through a pipeline without a script argument.
    if (!runsNodeOnStdin(beforeMarker) && !pipelineRunsBareNode(restOfLine)) continue

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

  // Aliases are dereferenced everywhere below, so values shared through `*anchor` are still checked.
  /**
   * @param {YAML.Node | undefined} node
   * @returns {YAML.Node | undefined}
   */
  const dereference = (node) => {
    while (YAML.isAlias(node)) node = node.resolve(document)
    return node
  }

  /**
   * Reads the node at `path` inside `map`, following aliases at every level.
   *
   * @param {YAML.Node | undefined} map
   * @param {string[]} path
   * @returns {YAML.Node | undefined}
   */
  const nodeAt = (map, path) => {
    let node = dereference(map)
    for (const key of path) {
      if (!YAML.isMap(node)) return
      node = dereference(node.get(key, true))
    }
    return node
  }

  /**
   * Reads the string scalar at `path` inside `map`, or `undefined` when the path is missing or not a string.
   *
   * @param {YAML.Node | undefined} map
   * @param {string[]} path
   * @returns {string | undefined}
   */
  const textAt = (map, path) => {
    const node = nodeAt(map, path)
    return YAML.isScalar(node) && typeof node.value === 'string' ? node.value : undefined
  }

  /**
   * Checks one step for JavaScript over the limit.
   *
   * @param {YAML.Node | undefined} step
   * @param {string | undefined} defaultsShell shell inherited from `defaults.run.shell`
   */
  const checkStep = (step, defaultsShell) => {
    const stepMap = dereference(step)
    if (!YAML.isMap(stepMap)) return

    const uses = textAt(stepMap, ['uses'])
    if (typeof uses === 'string' && uses.startsWith('actions/github-script@')) {
      const script = nodeAt(stepMap, ['with', 'script'])
      if (YAML.isScalar(script)) report(script, countLines(String(script.value)), 'actions/github-script script')
    }

    const run = nodeAt(stepMap, ['run'])
    if (!YAML.isScalar(run) || typeof run.value !== 'string') return

    // A step's own shell wins, then the job's defaults, then the workflow's.
    const shell = textAt(stepMap, ['shell']) ?? defaultsShell
    if (typeof shell === 'string' && /^node\b/.test(shell)) {
      report(run, countLines(run.value), 'node shell step')
      return
    }

    for (const { offset, lines } of findInlineNodeScripts(run.value)) {
      report(run, lines, 'inline node script', offset)
    }
  }

  const root = dereference(document.contents)
  const workflowShell = textAt(root, ['defaults', 'run', 'shell'])

  const jobs = nodeAt(root, ['jobs'])
  if (YAML.isMap(jobs)) {
    for (const job of jobs.items) {
      const jobMap = dereference(job.value)
      const shell = textAt(jobMap, ['defaults', 'run', 'shell']) ?? workflowShell
      const steps = nodeAt(jobMap, ['steps'])
      if (!YAML.isSeq(steps)) continue
      for (const step of steps.items) checkStep(step, shell)
    }
  }

  // Composite actions list their steps under `runs` instead of under `jobs`.
  const runs = nodeAt(root, ['runs'])
  const steps = nodeAt(runs, ['steps'])
  if (YAML.isSeq(steps)) {
    for (const step of steps.items) checkStep(step)
  }

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
