'use strict'

const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { stripVTControlCharacters: stripAnsi } = require('util')

const { globSync } = require('glob')

/**
 * @param {string[]} argv
 * @returns {{jobs?: number, timeout?: number, exposeGc: boolean, require: string[], patterns: string[]}}
 */
function parseArgs (argv) {
  /** @type {{jobs?: number, timeout?: number, exposeGc: boolean, require: string[], patterns: string[]}} */
  const opts = { exposeGc: false, require: [], patterns: [] }

  /** @type {string[]} */
  const rest = []
  let seenDoubleDash = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (seenDoubleDash) {
      rest.push(arg)
      continue
    }

    if (arg === '--') {
      seenDoubleDash = true
      continue
    }

    if (arg === '--expose-gc') {
      opts.exposeGc = true
      continue
    }

    if (arg === '--jobs') {
      const value = argv[++i]
      opts.jobs = value ? Number.parseInt(value, 10) : undefined
      continue
    }

    if (arg.startsWith('--jobs=')) {
      opts.jobs = Number.parseInt(arg.slice('--jobs='.length), 10)
      continue
    }

    if (arg === '--timeout') {
      const value = argv[++i]
      opts.timeout = value ? Number.parseInt(value, 10) : undefined
      continue
    }

    if (arg.startsWith('--timeout=')) {
      opts.timeout = Number.parseInt(arg.slice('--timeout='.length), 10)
      continue
    }

    if (arg === '--require' || arg === '-r') {
      const value = argv[++i]
      if (value) opts.require.push(value)
      continue
    }

    // Unknown flag; treat it as part of patterns to keep the tool flexible.
    rest.push(arg)
  }

  opts.patterns = rest
  return opts
}

function stableUnique (items) {
  return [...new Set(items)]
}

function ensureDir (dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function mergeXunitFilesToSingleTestsuite (inputFiles, outputFile) {
  let totalTests = 0
  let totalErrors = 0
  let totalFailures = 0
  let totalSkipped = 0
  let totalTime = 0
  const testcases = []

  for (const file of inputFiles) {
    const xml = fs.readFileSync(file, 'utf8')
    const openTagMatch = xml.match(/<testsuite\s+[^>]*>/)
    if (!openTagMatch) continue

    const openTag = openTagMatch[0]
    const openIdx = xml.indexOf(openTag)
    const closeTag = '</testsuite>'
    const closeIdx = xml.lastIndexOf(closeTag)
    if (openIdx === -1 || closeIdx === -1) continue

    const inner = xml.slice(openIdx + openTag.length, closeIdx)

    const attr = (name) => {
      const m = openTag.match(new RegExp(`${name}="([^"]*)"`))
      return m ? Number(m[1]) : 0
    }

    totalTests += attr('tests')
    totalFailures += attr('failures')
    totalErrors += attr('errors')
    totalSkipped += attr('skipped')
    totalTime += attr('time')

    testcases.push(inner.trim())
  }

  const timestamp = new Date().toUTCString()
  const merged = [
    `<testsuite name="Mocha Tests" tests="${totalTests}" failures="${totalFailures}" ` +
    `errors="${totalErrors}" skipped="${totalSkipped}" timestamp="${timestamp}" time="${totalTime}">`,
    testcases.filter(Boolean).join('\n'),
    '</testsuite>\n'
  ].join('\n')

  fs.writeFileSync(outputFile, merged)
}

async function main () {
  // If output is piped (e.g. to `head`), writes can throw EPIPE. Exit cleanly.
  process.stdout.on('error', (err) => {
    if (err && err.code === 'EPIPE') process.exit(0)
  })
  process.stderr.on('error', (err) => {
    if (err && err.code === 'EPIPE') process.exit(0)
  })

  const opts = parseArgs(process.argv.slice(2))
  if (opts.patterns.length === 0) {
    process.stderr.write(
      'Usage: node scripts/mocha-parallel-files.js [--jobs N] [--timeout MS] ' +
      '[--require path]... [--expose-gc] -- <glob|file>...\n'
    )
    process.exitCode = 2
    return
  }

  const jobs = typeof opts.jobs === 'number' && Number.isFinite(opts.jobs)
    ? Math.max(1, opts.jobs || 1)
    : Math.max(1, Math.min(os.cpus().length, 8))

  const timeout = typeof opts.timeout === 'number' && Number.isFinite(opts.timeout) ? opts.timeout : 30_000

  const expandedFiles = stableUnique(opts.patterns.flatMap(p =>
    globSync(p, { nodir: true, windowsPathsNoEscape: true }).sort((a, b) => a.localeCompare(b, 'en'))
  ))

  if (expandedFiles.length === 0) {
    process.stderr.write('No test files matched.\n')
    process.exitCode = 1
    return
  }

  const repoRoot = process.cwd()
  const runFileScript = path.join(repoRoot, 'scripts', 'mocha-run-file.js')

  const junitTmpDir = path.join(repoRoot, '.junit-tmp')
  const junitOutFile = path.join(repoRoot, `node-${process.versions.node}-junit.xml`)
  const junitTmpFiles = []
  const emitJunit = Boolean(process.env.CI)

  if (emitJunit) {
    fs.rmSync(junitOutFile, { force: true })

    if (jobs > 1) {
      ensureDir(junitTmpDir)
      // Clean up any stale junit shards.
      for (const entry of fs.readdirSync(junitTmpDir)) {
        if (entry.endsWith('.xml')) fs.rmSync(path.join(junitTmpDir, entry), { force: true })
      }
    }
  }

  let idx = 0
  let running = 0
  let failures = 0
  /** @type {{file: string, code: number|null, signal: NodeJS.Signals|null}[]} */
  const failed = []

  const isFailureStartLine = (line) => /\b\d+\s+failing\b/.test(stripAnsi(line))
  const isWarningLine = (line) => {
    const plain = stripAnsi(line)
    return (
      plain.includes('DeprecationWarning:') ||
      plain.includes('MaxListenersExceededWarning:') ||
      plain.includes('ExperimentalWarning:') ||
      plain.includes('Warning: ') ||
      plain.includes('Use `node --trace-warnings') ||
      plain.includes('Use `node --trace-deprecation')
    )
  }

  const splitLines = (carry, chunk) => {
    const next = carry + chunk
    const parts = next.split('\n')
    return { lines: parts.slice(0, -1).map(l => l + '\n'), carry: parts.at(-1) ?? '' }
  }

  const entries = expandedFiles.map((file) => ({
    file,
    started: false,
    exited: false,
    stdoutEnded: false,
    stderrEnded: false,
    code: /** @type {number|null} */ (null),
    signal: /** @type {NodeJS.Signals|null} */ (null),

    // Output buffers (in-memory)
    stdoutBuf: /** @type {string[]} */ ([]),
    stderrWarnBuf: /** @type {string[]} */ ([]),
    stderrErrBuf: /** @type {string[]} */ ([]),
    failureBuf: /** @type {string[]} */ ([]),

    stdoutCarry: '',
    stderrCarry: '',
    stdoutInFailure: false,

    stats: /** @type {{passes:number, failures:number, pending:number, tests:number, duration:number}|null} */ (null)
  }))

  let activeIndex = 0
  const isActive = (entryIndex) => entryIndex === activeIndex

  const flushActiveBuffers = () => {
    const entry = entries[activeIndex]
    if (!entry) return

    if (entry.stderrWarnBuf.length) {
      process.stderr.write(entry.stderrWarnBuf.join(''))
      entry.stderrWarnBuf.length = 0
    }
    if (entry.stdoutBuf.length) {
      process.stdout.write(entry.stdoutBuf.join(''))
      entry.stdoutBuf.length = 0
    }
  }

  const maybeAdvanceActive = () => {
    while (activeIndex < entries.length) {
      const entry = entries[activeIndex]
      // Only advance when the active entry is fully done and we have flushed what we buffered.
      if (entry.exited && entry.stdoutEnded && entry.stderrEnded) {
        flushActiveBuffers()
        activeIndex++
        flushActiveBuffers()
        continue
      }
      break
    }
  }

  const handleStdoutLine = (entryIndex, line) => {
    const entry = entries[entryIndex]
    if (!entry.stdoutInFailure && isFailureStartLine(line)) {
      entry.stdoutInFailure = true
    }
    if (entry.stdoutInFailure) {
      entry.failureBuf.push(line)
    } else {
      if (isActive(entryIndex)) process.stdout.write(line)
      else entry.stdoutBuf.push(line)
    }
  }

  const handleStdoutChunk = (entryIndex, chunk) => {
    const entry = entries[entryIndex]
    const { lines, carry } = splitLines(entry.stdoutCarry, chunk)
    entry.stdoutCarry = carry
    for (const line of lines) handleStdoutLine(entryIndex, line)
  }

  const handleStderrLine = (entryIndex, line) => {
    const entry = entries[entryIndex]
    if (isWarningLine(line)) {
      if (isActive(entryIndex)) process.stderr.write(line)
      else entry.stderrWarnBuf.push(line)
    } else {
      entry.stderrErrBuf.push(line)
    }
  }

  const handleStderrChunk = (entryIndex, chunk) => {
    const entry = entries[entryIndex]
    const { lines, carry } = splitLines(entry.stderrCarry, chunk)
    entry.stderrCarry = carry
    for (const line of lines) handleStderrLine(entryIndex, line)
  }

  const runPromise = new Promise((resolve) => {
    const launchNext = () => {
      while (running < jobs && idx < expandedFiles.length) {
        const entry = entries[idx]
        const file = entry.file
        idx++
        running++

        const junitShard = emitJunit
          ? (jobs > 1
              ? path.join(junitTmpDir, `node-${process.versions.node}-${process.pid}-${idx}.xml`)
              : junitOutFile)
          : undefined

        if (junitShard) junitTmpFiles.push(junitShard)

        /** @type {any} */
        const reporterOptions = emitJunit
          ? {
              reporterEnabled: ['spec', 'xunit'],
              xunitReporterOptions: { output: junitShard }
            }
          : {
              reporterEnabled: ['spec']
            }

        const childEnv = {
          ...process.env,
          MOCHA_RUN_FILE_CONFIG: JSON.stringify({
            timeout,
            color: true,
            reporter: 'mocha-multi-reporters',
            reporterOptions,
            require: opts.require
          }),
        }

        const nodeArgs = []
        if (opts.exposeGc) nodeArgs.push('--expose-gc')
        nodeArgs.push(runFileScript, file)

        entry.started = true

        const child = spawn(process.execPath, nodeArgs, {
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          env: childEnv
        })

        if (!child.stdout || !child.stderr) {
          throw new Error('Expected child stdout/stderr to be piped')
        }

        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')

        const entryIndex = idx - 1

        child.stdout.on('data', (data) => {
          handleStdoutChunk(entryIndex, data)
        })
        child.stderr.on('data', (data) => {
          handleStderrChunk(entryIndex, data)
        })

        child.on('message', (msg) => {
          const m = /** @type {any} */ (msg)
          if (m && typeof m === 'object' && m.type === 'mocha-run-file-result') {
            entries[entryIndex].stats = {
              passes: m.passes || 0,
              failures: m.failures || 0,
              pending: m.pending || 0,
              tests: m.tests || 0,
              duration: m.duration || 0
            }
          }
        })

        child.stdout.on('end', () => {
          const entry = entries[entryIndex]
          if (entry.stdoutCarry) {
            const tail = entry.stdoutCarry
            entry.stdoutCarry = ''
            // process leftover without newline
            handleStdoutLine(entryIndex, tail)
          }
          entry.stdoutEnded = true
          maybeAdvanceActive()
        })

        child.stderr.on('end', () => {
          const entry = entries[entryIndex]
          if (entry.stderrCarry) {
            const tail = entry.stderrCarry
            entry.stderrCarry = ''
            handleStderrLine(entryIndex, tail)
          }
          entry.stderrEnded = true
          maybeAdvanceActive()
        })

        child.on('exit', (code, signal) => {
          running--
          if (code || signal) {
            failures++
            failed.push({ file, code, signal })
          }

          entry.exited = true
          entry.code = code
          entry.signal = signal

          if (idx >= expandedFiles.length && running === 0) {
            resolve(undefined)
          } else {
            launchNext()
          }

          maybeAdvanceActive()
        })
      }
    }

    launchNext()
  })

  // Wait for all children to complete. Output is emitted live via stream handlers above.
  await runPromise
  // Ensure any remaining buffered output for the last active file is flushed.
  flushActiveBuffers()

  // Print buffered error output (non-warning stderr + mocha failure blocks) after all output has been streamed.
  let globalFailureIndex = 0
  let hasConsolidatedErrors = false
  for (const entry of entries) {
    const stderrErrors = entry.stderrErrBuf.join('').trim()
    const hasFailures = entry.failureBuf.length > 0
    if (!stderrErrors && !hasFailures) continue

    if (!hasConsolidatedErrors) {
      process.stdout.write('\n=== Errors ===\n')
      hasConsolidatedErrors = true
    }

    if (stderrErrors) {
      process.stdout.write(stderrErrors)
      const last = entry.stderrErrBuf[entry.stderrErrBuf.length - 1]
      if (last && !last.endsWith('\n')) process.stdout.write('\n')
    }
    if (hasFailures) {
      let appendedFilenameToFailingLine = false

      for (const line of entry.failureBuf) {
        let out = line

        // Print `n failing in <file>` while ensuring the appended filename stays uncolored.
        if (!appendedFilenameToFailingLine && isFailureStartLine(out)) {
          appendedFilenameToFailingLine = true

          const hasNewline = out.endsWith('\n')
          const base = hasNewline ? out.slice(0, -1) : out
          // Ensure `in <file>` is not red by resetting ANSI styles before printing the filename.
          // Avoid double-resetting if the line already ends with a reset.
          const reset = '\u001b[0m'
          out = (base.endsWith(reset) ? base : base + reset) + ' in ' + entry.file + (hasNewline ? '\n' : '')
        }

        // Prefix local `n)` failure lines with a deterministic global counter `[n]`.
        if (/^\s*\d+\)/.test(stripAnsi(out))) {
          globalFailureIndex++
          out = `[${globalFailureIndex}] ` + out
        }

        process.stdout.write(out)
      }

      const last = entry.failureBuf[entry.failureBuf.length - 1]
      if (last && !last.endsWith('\n')) process.stdout.write('\n')
    }
  }

  if (emitJunit) {
    // Merge xunit shards (one per file) into the historical output file name expected by CI tooling.
    if (jobs > 1) {
      mergeXunitFilesToSingleTestsuite(junitTmpFiles.filter(f => fs.existsSync(f)), junitOutFile)
    }
  }

  // Summary (always at the very end)
  let totalPasses = 0
  let totalFailures = 0
  let totalPending = 0
  let totalTests = 0
  let totalDuration = 0

  for (const entry of entries) {
    const result = entry.stats
    if (!result) continue
    totalPasses += result.passes || 0
    totalFailures += result.failures || 0
    totalPending += result.pending || 0
    totalTests += result.tests || 0
    totalDuration += result.duration || 0
  }

  process.stdout.write('\n=== Summary ===\n')
  process.stdout.write(`Passed: ${totalPasses}\n`)
  process.stdout.write(`Failed: ${totalFailures}\n`)
  process.stdout.write(`Pending: ${totalPending}\n`)
  process.stdout.write(`Total: ${totalTests}\n`)
  process.stdout.write(`Duration(ms): ${totalDuration}\n`)

  if (failed.length) {
    process.stdout.write('\n=== Failed files ===\n')
    for (const { file, code, signal } of failed) {
      process.stdout.write(`- ${file} (exit=${code ?? 'null'} signal=${signal ?? 'null'})\n`)
    }
    process.stdout.write(
      'Legend: [n] = global failure index across all files; n) = local failure index within a file.\n'
    )
  }

  process.exit(failures ? 1 : 0)
}

main().catch(err => {
  process.stderr.write(String(err?.stack || err) + '\n')
  process.exitCode = 1
})
