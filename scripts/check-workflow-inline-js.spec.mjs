import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, it } from 'mocha'

const repositoryDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const checkerPath = join(repositoryDirectory, 'scripts', 'check-workflow-inline-js.js')

/**
 * @param {number} count
 * @param {number} indent
 */
function jsLines (count, indent) {
  return Array.from({ length: count }, (_, index) => `${' '.repeat(indent)}console.log(${index})`).join('\n')
}

/**
 * @param {string[]} lines
 * @param {number} indent
 */
function indented (lines, indent) {
  return lines.map(line => `${' '.repeat(indent)}${line}`).join('\n')
}

/**
 * @param {number} count
 * @param {number} indent
 */
function githubScriptStep (count, indent) {
  return [
    indented([
      '- uses: actions/github-script@0000000000000000000000000000000000000000 # v9.0.0',
      '  with:',
      '    script: |',
    ], indent),
    jsLines(count, indent + 6),
  ].join('\n')
}

/**
 * @param {number} count
 */
function nodeShellStep (count) {
  return [indented(['- shell: node {0}', '  run: |'], 6), jsLines(count, 10)].join('\n')
}

/**
 * @param {string} flag
 * @param {number} count
 */
function nodeEvalStep (flag, count) {
  return indented([
    '- run: |',
    '    echo start',
    `    VALUE=$(node --input-type=module ${flag} \\`,
    `      "${jsLines(count, 12).trimStart()}")`,
    '    echo "$VALUE"',
  ], 6)
}

/**
 * @param {number} count
 */
function singleQuotedEvalStep (count) {
  return indented(['- run: |', `    node -e '${jsLines(count, 12).trimStart()}'`], 6)
}

/**
 * @param {number} count
 */
function ansiCQuotedEvalStep (count) {
  return indented(['- run: |', `    node -e $'${jsLines(count, 12).trimStart()}'`], 6)
}

/**
 * @param {number} count
 * @param {string} [delimiter]
 */
function heredocStep (count, delimiter = 'EOF') {
  return [
    indented(['- run: |', `    node --input-type=module <<'${delimiter}'`], 6),
    jsLines(count, 10),
    indented([`    ${delimiter}`, '    echo done'], 6),
  ].join('\n')
}

describe('check-workflow-inline-js', () => {
  let temporaryDirectory

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'dd-trace-workflow-inline-js-'))
  })

  afterEach(() => {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  })

  /**
   * @param {string} path
   * @param {string} content
   */
  function runChecker (path, content) {
    mkdirSync(join(temporaryDirectory, dirname(path)), { recursive: true })
    writeFileSync(join(temporaryDirectory, path), `${content}\n`)

    return spawnSync(process.execPath, [checkerPath], {
      cwd: temporaryDirectory,
      encoding: 'utf8',
    })
  }

  /**
   * @param {string} steps
   */
  function runWorkflow (steps) {
    const content = `name: Test\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`
    return runChecker('.github/workflows/test.yml', content)
  }

  it('accepts an actions/github-script script with 5 lines', () => {
    const result = runWorkflow(githubScriptStep(5, 6))

    assert.strictEqual(result.status, 0)
    assert.strictEqual(result.stderr, '')
  })

  it('rejects an actions/github-script script with 6 lines', () => {
    const result = runWorkflow(githubScriptStep(6, 6))

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /^\.github\/workflows\/test\.yml:10: actions\/github-script script has 6 lines/m)
    assert.match(result.stderr, /Keep JavaScript in GitHub Actions YAML at 5 lines or fewer/)
    assert.match(result.stderr, /Move longer code into a file under scripts\//)
  })

  it('rejects long scripts in composite actions', () => {
    const content = `name: Test\nruns:\n  using: composite\n  steps:\n${githubScriptStep(6, 2)}`
    const result = runChecker('.github/actions/test/action.yml', content)

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /^\.github\/actions\/test\/action\.yml:8: actions\/github-script script has 6 lines/m)
  })

  it('checks steps that use node as their shell', () => {
    assert.strictEqual(runWorkflow(nodeShellStep(5)).status, 0)

    const result = runWorkflow(nodeShellStep(6))
    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /test\.yml:9: node shell step has 6 lines/)
  })

  it('checks double quoted node eval arguments, including line continuations', () => {
    for (const flag of ['-e', '-p', '--eval', '--print']) {
      assert.strictEqual(runWorkflow(nodeEvalStep(flag, 5)).status, 0, flag)

      const result = runWorkflow(nodeEvalStep(flag, 6))
      assert.strictEqual(result.status, 1, flag)
      assert.match(result.stderr, /test\.yml:9: inline node script has 6 lines/, flag)
    }
  })

  it('checks single quoted node eval arguments', () => {
    assert.strictEqual(runWorkflow(singleQuotedEvalStep(5)).status, 0)
    assert.strictEqual(runWorkflow(singleQuotedEvalStep(6)).status, 1)
  })

  it('checks ANSI-C quoted node eval arguments', () => {
    assert.strictEqual(runWorkflow(ansiCQuotedEvalStep(5)).status, 0)
    assert.strictEqual(runWorkflow(ansiCQuotedEvalStep(6)).status, 1)
  })

  it('checks node heredocs', () => {
    for (const delimiter of ['EOF', 'JS-END']) {
      assert.strictEqual(runWorkflow(heredocStep(5, delimiter)).status, 0, delimiter)

      const result = runWorkflow(heredocStep(6, delimiter))
      assert.strictEqual(result.status, 1, delimiter)
      assert.match(result.stderr, /test\.yml:8: inline node script has 6 lines/, delimiter)
    }
  })

  it('ignores long shell scripts that only run node files', () => {
    const lines = Array.from({ length: 10 }, (_, index) => `    node scripts/step-${index}.js`)
    const result = runWorkflow(indented(['- run: |', ...lines], 6))

    assert.strictEqual(result.status, 0)
    assert.strictEqual(result.stderr, '')
  })
})
