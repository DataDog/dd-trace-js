#!/usr/bin/env node

// This check enforces `curly: ['error', 'all']` (braces required on every
// if/else/for/while body) but ONLY on lines added or modified relative to the
// PR's merge-base with its target branch.
//
// Why: reviewers have repeatedly had to ask contributors to add braces to
// brace-less single-statement if/else bodies during code review (e.g.
// https://github.com/DataDog/dd-trace-js/pull/10585, where a reviewer flagged
// a naked `if (x) a(); else b()` and the author accepted the suggestion and
// pushed a follow-up commit adding braces). This is a mechanically detectable,
// low-false-positive pattern that ESLint's built-in `curly` rule already
// knows how to find — the repo's shared `eslint.config.mjs` just has it
// configured more leniently (`multi-line`, which still allows brace-less
// single-line bodies) for historical/compatibility reasons.
//
// Flipping `curly` to `'all'` repo-wide would fail on ~4,900 pre-existing
// occurrences across the codebase, which the automation guardrails explicitly
// forbid doing in one shot. Instead, this script re-lints only files touched
// by the current branch with a stricter, in-memory rule override, and reports
// a violation only when it falls on a line that was actually added or
// modified in this branch. This way the rule is enforced going forward,
// tightens coverage incrementally as files are naturally touched, and never
// requires an unrelated reformat of existing code.

import { execFileSync } from 'node:child_process'
import { ESLint } from 'eslint'

const BASE_REF = process.env.GITHUB_BASE_REF
  ? `origin/${process.env.GITHUB_BASE_REF}`
  : (process.argv[2] || 'origin/master')

function sh (args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function getMergeBase (base) {
  try {
    return sh(['merge-base', base, 'HEAD'])
  } catch {
    // Fall back to comparing directly against `base` (e.g. shallow clones,
    // or when `base` is already a commit SHA rather than a ref).
    return base
  }
}

function getChangedFiles (base) {
  const out = sh([
    'diff', '--name-only', '--diff-filter=ACMR', base, 'HEAD', '--',
    '*.js', '*.jsx', '*.mjs', '*.cjs',
  ])
  return out ? out.split('\n').filter(Boolean) : []
}

// Returns a Set of 1-based line numbers added/modified in `file` relative to `base`.
function getChangedLines (base, file) {
  const diff = sh(['diff', '-U0', base, 'HEAD', '--', file])
  const lines = new Set()
  let currentLine = null
  for (const line of diff.split('\n')) {
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunkMatch) {
      currentLine = Number(hunkMatch[1])
      continue
    }
    if (currentLine === null) continue
    if (line.startsWith('+') && !line.startsWith('+++')) {
      lines.add(currentLine)
      currentLine++
    } else if (!line.startsWith('-') && !line.startsWith('\\')) {
      currentLine++
    }
  }
  return lines
}

async function main () {
  const base = getMergeBase(BASE_REF)
  const files = getChangedFiles(base)
  if (files.length === 0) {
    console.log('No changed JS files to check for brace style.')
    return
  }

  const eslint = new ESLint({
    overrideConfig: { rules: { curly: ['error', 'all'] } },
  })

  let failed = false
  for (const file of files) {
    const changedLines = getChangedLines(base, file)
    if (changedLines.size === 0) continue
    if (await eslint.isPathIgnored(file)) continue

    let results
    try {
      results = await eslint.lintFiles([file])
    } catch {
      // File may have been deleted since the diff was computed; skip it.
      continue
    }

    for (const result of results) {
      for (const message of result.messages) {
        if (message.ruleId !== 'curly') continue
        if (!changedLines.has(message.line)) continue
        failed = true
        console.error(
          `${file}:${message.line}:${message.column} ${message.message} ` +
          '(new/modified line must use braces on this control-flow body)'
        )
      }
    }
  }

  if (failed) {
    console.error(
      '\nOne or more lines you added or modified use a brace-less if/else/for/while body. ' +
      'Add braces, e.g. `if (x) { y() }` instead of `if (x) y()`. This check only scans lines ' +
      'you changed; it does not require reformatting unrelated existing code.'
    )
    process.exitCode = 1
  } else {
    console.log('No brace-style (curly) violations on changed lines.')
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
