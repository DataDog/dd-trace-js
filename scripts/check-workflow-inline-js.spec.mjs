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
 * A step running `command -e '...'` with the eval argument on its own lines.
 *
 * @param {number} count
 * @param {string} command
 */
function nodeEvalCommandStep (count, command) {
  return [
    indented(['- run: |', `    ${command} -e '`], 6),
    jsLines(count, 10),
    indented(["    '"], 6),
  ].join('\n')
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

/**
 * A step whose heredoc is attached to `command` rather than to a fixed node invocation.
 *
 * @param {number} count
 * @param {string} command
 */
function commandHeredocStep (count, command) {
  return [
    indented(['- run: |', `    ${command} <<'EOF'`], 6),
    jsLines(count, 10),
    indented(['    EOF'], 6),
  ].join('\n')
}

/**
 * @param {number} count
 * @param {string} [tail] shell following the bare node command, like a redirection or comment
 */
function pipedHeredocStep (count, tail = '') {
  return [
    indented(['- run: |', `    cat <<'JS' | node ${tail}`.replace(/ $/, '')], 6),
    jsLines(count, 10),
    indented(['    JS'], 6),
  ].join('\n')
}

/**
 * @param {number} count
 * @param {string} [args] the words following node in the command that reads the pipe
 */
function heredocPipedToFileStep (count, args = 'scripts/step.js') {
  return [
    indented(['- run: |', `    cat <<'JS' | node ${args}`], 6),
    jsLines(count, 10),
    indented(['    JS'], 6),
  ].join('\n')
}

/**
 * @param {number} count
 */
function powershellHereStringStep (count) {
  return [
    indented(['- shell: pwsh', '  run: |', "    node -e @'"], 6),
    jsLines(count, 10),
    indented(["    '@"], 6),
  ].join('\n')
}

/**
 * A step whose heredoc-reading command is split across lines by a backslash continuation.
 *
 * @param {number} count
 */
function continuedHeredocStep (count) {
  return [
    indented(['- run: |', '    node \\', "    --input-type=module <<'JS'"], 6),
    jsLines(count, 10),
    indented(['    JS'], 6),
  ].join('\n')
}

/**
 * A workflow whose single run step inherits its shell from workflow-, job- or step-level defaults.
 *
 * @param {{ count?: number, workflowShell?: string, jobShell?: string, stepShell?: string }} [options]
 */
function defaultsShellWorkflow ({ count = 6, workflowShell, jobShell, stepShell } = {}) {
  const lines = ['name: Test', 'on: push']
  if (workflowShell) lines.push('defaults:', '  run:', `    shell: ${workflowShell}`)
  lines.push('jobs:', '  test:', '    runs-on: ubuntu-latest')
  if (jobShell) lines.push('    defaults:', '      run:', `        shell: ${jobShell}`)
  const step = indented(stepShell ? [`- shell: ${stepShell}`, '  run: |'] : ['- run: |'], 6)
  lines.push('    steps:', step, jsLines(count, 10))
  return lines.join('\n')
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

  it('checks scripts shared through YAML aliases', () => {
    const content = [
      'name: Test',
      'on: push',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      indented([
        '- uses: actions/github-script@0000000000000000000000000000000000000000 # v9.0.0',
        '  with:',
        '    script: &shared |',
      ], 6),
      jsLines(6, 12),
      indented([
        '- uses: actions/github-script@0000000000000000000000000000000000000000 # v9.0.0',
        '  with:',
        '    script: *shared',
      ], 6),
    ].join('\n')
    const result = runChecker('.github/workflows/test.yml', content)

    assert.strictEqual(result.status, 1)
    assert.strictEqual(result.stderr.match(/has 6 lines/g).length, 2)
    assert.match(result.stderr, /^\.github\/workflows\/test\.yml:10: actions\/github-script script has 6 lines/m)
  })

  it('checks steps that use node as their shell', () => {
    assert.strictEqual(runWorkflow(nodeShellStep(5)).status, 0)

    const result = runWorkflow(nodeShellStep(6))
    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /test\.yml:9: node shell step has 6 lines/)
  })

  it('checks run steps that inherit a node shell from workflow defaults', () => {
    assert.strictEqual(
      runChecker('.github/workflows/test.yml', defaultsShellWorkflow({ count: 5, workflowShell: 'node {0}' })).status,
      0
    )

    const result = runChecker('.github/workflows/test.yml', defaultsShellWorkflow({ workflowShell: 'node {0}' }))
    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /test\.yml:11: node shell step has 6 lines/)
  })

  it('checks run steps that inherit a node shell from job defaults', () => {
    const content = defaultsShellWorkflow({ workflowShell: 'bash', jobShell: 'node {0}' })
    const result = runChecker('.github/workflows/test.yml', content)

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /test\.yml:14: node shell step has 6 lines/)
  })

  it('lets nearer shells override inherited node defaults', () => {
    for (const content of [
      defaultsShellWorkflow({ workflowShell: 'node {0}', jobShell: 'bash' }),
      defaultsShellWorkflow({ workflowShell: 'node {0}', stepShell: 'bash' }),
    ]) {
      const result = runChecker('.github/workflows/test.yml', content)

      assert.strictEqual(result.status, 0)
      assert.strictEqual(result.stderr, '')
    }
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

  it('checks eval code after node options', () => {
    assert.strictEqual(runWorkflow(nodeEvalCommandStep(5, 'node --no-warnings')).status, 0)

    const result = runWorkflow(nodeEvalCommandStep(6, 'node --no-warnings'))
    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /test\.yml:8: inline node script has 6 lines/)
  })

  it('checks eval flags after options whose values look like flags', () => {
    const result = runWorkflow(nodeEvalCommandStep(6, 'node --title -e'))

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /test\.yml:8: inline node script has 6 lines/)
  })

  it('checks eval flags after attached option values with spaces', () => {
    const result = runWorkflow(nodeEvalCommandStep(6, "node --title='workflow check'"))

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /test\.yml:8: inline node script has 6 lines/)
  })

  it('ignores eval flags that belong to a script node runs', () => {
    for (const command of ['node scripts/process.js', 'node --require x.cjs scripts/run.js']) {
      const result = runWorkflow(nodeEvalCommandStep(10, command))

      assert.strictEqual(result.status, 0, command)
      assert.strictEqual(result.stderr, '', command)
    }
  })

  it('ignores eval flags that are values of the preceding option or redirection', () => {
    for (const command of ['node 2>', 'node --require']) {
      const result = runWorkflow(nodeEvalCommandStep(6, command))

      assert.strictEqual(result.status, 0, command)
      assert.strictEqual(result.stderr, '', command)
    }
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

  it('checks heredoc programs node reads with wrappers, options and redirects', () => {
    for (const command of [
      'node --input-type=module 2>/dev/null',
      'node --require ./ci/preload.cjs',
      'node -r ./preload.cjs',
      'node --import ./module.mjs',
      'node 2>&1',
      'node 2>& 1',
      'node >& 2',
      'node &>/dev/null',
      'node &>>log',
      'node 2> /dev/null',
      'node > /dev/null',
      'sudo node',
      'NODE_OPTIONS=x node',
    ]) {
      const result = runWorkflow(commandHeredocStep(6, command))

      assert.strictEqual(result.status, 1, command)
      assert.match(result.stderr, /test\.yml:8: inline node script has 6 lines/, command)
    }
  })

  it('ignores heredocs feeding data to a node script file', () => {
    for (const command of [
      'node scripts/process-input.js',
      'node --require ./ci/preload.cjs scripts/process-input.js',
      'node &> /dev/null scripts/process.js',
    ]) {
      const result = runWorkflow(commandHeredocStep(10, command))

      assert.strictEqual(result.status, 0, command)
      assert.strictEqual(result.stderr, '', command)
    }
  })

  it('ignores heredocs when node is only a word in the command', () => {
    const result = runWorkflow(commandHeredocStep(10, 'echo node'))

    assert.strictEqual(result.status, 0)
    assert.strictEqual(result.stderr, '')
  })

  it('checks heredocs piped into node', () => {
    assert.strictEqual(runWorkflow(pipedHeredocStep(5)).status, 0)

    const result = runWorkflow(pipedHeredocStep(6))
    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /test\.yml:8: inline node script has 6 lines/)
  })

  it('checks heredocs piped into node followed by a redirection or comment', () => {
    for (const tail of ['2>/dev/null', '# comment']) {
      const result = runWorkflow(pipedHeredocStep(6, tail))

      assert.strictEqual(result.status, 1, tail)
      assert.match(result.stderr, /test\.yml:8: inline node script has 6 lines/, tail)
    }
  })

  it('ignores heredocs piped into node running a file', () => {
    for (const args of ['scripts/step.js', '--no-warnings scripts/process.js']) {
      const result = runWorkflow(heredocPipedToFileStep(10, args))

      assert.strictEqual(result.status, 0, args)
      assert.strictEqual(result.stderr, '', args)
    }
  })

  it('checks heredocs attached through line continuations', () => {
    assert.strictEqual(runWorkflow(continuedHeredocStep(5)).status, 0)

    const result = runWorkflow(continuedHeredocStep(6))
    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /test\.yml:9: inline node script has 6 lines/)
  })

  it('checks PowerShell here-strings passed to node', () => {
    assert.strictEqual(runWorkflow(powershellHereStringStep(5)).status, 0)

    const result = runWorkflow(powershellHereStringStep(6))
    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /test\.yml:9: inline node script has 6 lines/)
  })

  it('ignores long shell scripts that only run node files', () => {
    const lines = Array.from({ length: 10 }, (_, index) => `    node scripts/step-${index}.js`)
    const result = runWorkflow(indented(['- run: |', ...lines], 6))

    assert.strictEqual(result.status, 0)
    assert.strictEqual(result.stderr, '')
  })
})
