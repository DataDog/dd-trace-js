'use strict'

const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { stripVTControlCharacters: stripAnsi } = require('util')

const { globSync } = require('glob')

const multiMochaRc = require('../.mochamultireporterrc')

function getTestsuiteAttr (openTag, name) {
  const m = openTag.match(new RegExp(`${name}="([^"]*)"`))
  if (!m) return 0
  // `time` is decimal seconds; the rest are integer counts.
  const value = name === 'time' ? Number.parseFloat(m[1]) : Number.parseInt(m[1], 10)
  return Number.isFinite(value) ? value : 0
}

function isFailureStartLine (line) {
  // Anchored so test names containing "N failing" don't flip stdoutInFailure.
  return /^\s*\d+\s+failing\b/.test(stripAnsi(line))
}

function isWarningLine (line) {
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

function splitLines (carry, chunk) {
  const next = carry + chunk
  const parts = next.split('\n')
  return { lines: parts.slice(0, -1).map(l => l + '\n'), carry: parts.at(-1) ?? '' }
}

/**
 * @typedef {{
 *   reporterEnabled: string[],
 *   xunitReporterOptions?: { output: string }
 * }} ReporterOptions
 *
 * @typedef {{
 *   type: 'mocha-run-file-result',
 *   passes?: number,
 *   failures?: number,
 *   pending?: number,
 *   tests?: number,
 *   duration?: number
 * }} MochaRunFileResultMessage
 */

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

/**
 * Best-effort filesystem cleanup. On Windows, junit shards can be held open by
 * AV / editors / a leftover child from a previous run; treating that as a hard
 * failure aborts the whole test run before mocha even starts.
 *
 * @param {string} file
 */
function bestEffortRm (file) {
  try {
    fs.rmSync(file, { force: true })
  } catch (err) {
    process.stderr.write(`mocha-parallel-files: failed to remove ${file}: ${err.message}\n`)
  }
}

function mergeXunitFilesToSingleTestsuite (inputFiles, outputFile) {
  let totalTests = 0
  let totalErrors = 0
  let totalFailures = 0
  let totalSkipped = 0
  let totalTime = 0
  const testcases = []

  for (const file of inputFiles) {
    let xml
    try {
      xml = fs.readFileSync(file, 'utf8')
    } catch (err) {
      process.stderr.write(`mocha-parallel-files: failed to read ${file}: ${err.message}\n`)
      continue
    }

    const openTagMatch = xml.match(/<testsuite\s+[^>]*>/)
    if (!openTagMatch) continue

    const openTag = openTagMatch[0]
    const openIdx = xml.indexOf(openTag)
    const closeTag = '</testsuite>'
    const closeIdx = xml.lastIndexOf(closeTag)
    if (openIdx === -1 || closeIdx === -1) continue

    const inner = xml.slice(openIdx + openTag.length, closeIdx)

    totalTests += getTestsuiteAttr(openTag, 'tests')
    totalFailures += getTestsuiteAttr(openTag, 'failures')
    totalErrors += getTestsuiteAttr(openTag, 'errors')
    totalSkipped += getTestsuiteAttr(openTag, 'skipped')
    totalTime += getTestsuiteAttr(openTag, 'time')

    testcases.push(inner.trim())
  }

  const timestamp = new Date().toUTCString()
  const merged = [
    `<testsuite name="Mocha Tests" tests="${totalTests}" failures="${totalFailures}" ` +
    `errors="${totalErrors}" skipped="${totalSkipped}" timestamp="${timestamp}" time="${totalTime}">`,
    testcases.filter(Boolean).join('\n'),
    '</testsuite>\n',
  ].join('\n')

  try {
    fs.writeFileSync(outputFile, merged)
  } catch (err) {
    process.stderr.write(`mocha-parallel-files: failed to write ${outputFile}: ${err.message}\n`)
  }
}

/**
 * @param {unknown} msg
 * @returns {msg is MochaRunFileResultMessage}
 */
function isMochaRunFileResultMessage (msg) {
  if (!msg || typeof msg !== 'object') return false
  return /** @type {Record<string, unknown>} */ (msg).type === 'mocha-run-file-result'
}

async function main () {
  /** @type {Set<import('child_process').ChildProcess>} */
  const liveChildren = new Set()
  let interrupted = false

  // EPIPE: the consumer (e.g. `head`) closed the pipe. Kill remaining children
  // and exit with whatever exit code the run has earned so far.
  const onPipeError = (err) => {
    if (!err || err.code !== 'EPIPE') return
    if (interrupted) return
    interrupted = true
    for (const child of liveChildren) {
      child.kill('SIGTERM')
    }
    process.exit(process.exitCode ?? 0)
  }
  process.stdout.on('error', onPipeError)
  process.stderr.on('error', onPipeError)

  const onSignal = (signal) => {
    if (interrupted) return
    interrupted = true
    process.stderr.write(
      `\nmocha-parallel-files: received ${signal}, terminating ${liveChildren.size} child(ren)\n`
    )
    for (const child of liveChildren) {
      child.kill(signal)
    }
    // Force-exit if children don't comply within a second. SIGINT → 130, SIGTERM → 143.
    setTimeout(() => {
      for (const child of liveChildren) {
        child.kill('SIGKILL')
      }
      process.exit(signal === 'SIGINT' ? 130 : 143)
    }, 1000).unref()
  }
  process.once('SIGINT', () => onSignal('SIGINT'))
  process.once('SIGTERM', () => onSignal('SIGTERM'))

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

  const expandedFiles = stableUnique(
    opts.patterns
      .flatMap(p => globSync(p, { nodir: true, windowsPathsNoEscape: true }))
      .sort((a, b) => a.localeCompare(b, 'en'))
  )

  if (expandedFiles.length === 0) {
    process.stderr.write('No test files matched.\n')
    process.exitCode = 1
    return
  }

  const repoRoot = process.cwd()
  const runFileScript = path.join(repoRoot, 'scripts', 'mocha-run-file.js')

  const junitTmpDir = path.join(repoRoot, '.junit-tmp')
  const junitOutFile = path.join(repoRoot, multiMochaRc.scriptsJunitReporterJsReporterOptions.mochaFile)
  const junitTmpFiles = []
  const emitJunit = Boolean(process.env.CI)

  if (emitJunit) {
    bestEffortRm(junitOutFile)
    ensureDir(junitTmpDir)
    try {
      // Clean up any stale junit shards.
      for (const entry of fs.readdirSync(junitTmpDir)) {
        if (entry.endsWith('.xml')) bestEffortRm(path.join(junitTmpDir, entry))
      }
    } catch (err) {
      process.stderr.write(`mocha-parallel-files: failed to scan ${junitTmpDir}: ${err.message}\n`)
    }
  }

  let idx = 0
  let running = 0
  let failures = 0
  /** @type {{file: string, code: number|null, signal: NodeJS.Signals|null}[]} */
  const failed = []

  const entries = expandedFiles.map((file) => ({
    file,
    started: false,
    exited: false,
    stdoutEnded: false,
    stderrEnded: false,
    code: /** @type {number|null} */ (null),
    signal: /** @type {NodeJS.Signals|null} */ (null),

    // Output buffers (in-memory). For non-active entries, preserve stdout/stderr warning ordering
    // by buffering a merged stream with per-line ordering.
    outBuf: /** @type {{stream:'stdout'|'stderr', text:string}[]} */ ([]),
    stderrErrBuf: /** @type {string[]} */ ([]),
    failureBuf: /** @type {string[]} */ ([]),

    stdoutCarry: '',
    stderrCarry: '',
    stdoutInFailure: false,

    stats: /** @type {{passes:number, failures:number, pending:number, tests:number, duration:number}|null} */ (null),
  }))

  /**
   * Mark a child as failed without a real exit code (spawn error, missing
   * stdio, sync spawn throw). Uses `code = 1` so summary accounting and the
   * crashedFiles bucket pick it up.
   */
  const recordSpawnFailure = (entry, file) => {
    if (entry.exited) return
    entry.exited = true
    entry.code = 1
    entry.signal = null
    entry.stdoutEnded = true
    entry.stderrEnded = true
    running--
    failures++
    failed.push({ file, code: 1, signal: null })
    process.exitCode = 1
  }

  let activeIndex = 0
  const isActive = (entryIndex) => entryIndex === activeIndex

  const flushActiveBuffers = () => {
    const entry = entries[activeIndex]
    if (!entry) return

    if (entry.outBuf.length) {
      for (const { stream, text } of entry.outBuf) {
        if (stream === 'stderr') process.stderr.write(text)
        else process.stdout.write(text)
      }
      entry.outBuf.length = 0
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
      else entry.outBuf.push({ stream: 'stdout', text: line })
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
      else entry.outBuf.push({ stream: 'stderr', text: line })
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

  /** @type {Promise<void>} */
  const runPromise = new Promise((resolve) => {
    const checkDone = () => {
      if (running === 0 && (idx >= expandedFiles.length || interrupted)) {
        resolve()
      }
    }

    const safeLaunchNext = () => {
      try {
        launchNext()
      } catch (err) {
        process.stderr.write(`mocha-parallel-files: launchNext failed: ${err.message}\n`)
        process.exitCode = 1
        resolve()
      }
    }

    const launchNext = () => {
      while (running < jobs && idx < expandedFiles.length) {
        if (interrupted) break
        const entry = entries[idx]
        const file = entry.file
        const entryIndex = idx
        idx++
        running++

        const junitShard = emitJunit
          ? path.join(junitTmpDir, `node-${process.versions.node}-${process.pid}-${entryIndex + 1}.xml`)
          : null

        if (junitShard) junitTmpFiles.push(junitShard)

        /** @type {ReporterOptions} */
        const reporterOptions = emitJunit
          ? {
              reporterEnabled: ['spec', 'xunit'],
              xunitReporterOptions: { output: /** @type {string} */ (junitShard), showRelativePaths: true },
            }
          : {
              reporterEnabled: ['spec'],
            }

        const options = {
          reporterOptions,
        }

        if (timeout !== undefined) {
          options.timeout = timeout
        }

        if (opts.require.length) {
          options.require = opts.require
        }

        // Enable shared tarball caching for parallel runs to avoid redundant packing
        const DD_TEST_SANDBOX_TARBALL_PATH = process.env.DD_TEST_SANDBOX_TARBALL_PATH ||
          (jobs > 1 ? path.join(os.tmpdir(), 'dd-trace-integration-test.tgz') : undefined)

        const childEnv = {
          ...process.env,
          DD_TEST_SANDBOX_TARBALL_PATH,
          MOCHA_RUN_FILE_CONFIG: JSON.stringify(options),
        }

        const nodeArgs = []
        if (opts.exposeGc) nodeArgs.push('--expose-gc')
        nodeArgs.push(runFileScript, file)

        entry.started = true

        let child
        try {
          child = spawn(process.execPath, nodeArgs, {
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            env: childEnv,
          })
        } catch (err) {
          process.stderr.write(`mocha-parallel-files: spawn failed for ${file}: ${err.message}\n`)
          recordSpawnFailure(entry, file)
          continue
        }

        if (!child.stdout || !child.stderr) {
          process.stderr.write(`mocha-parallel-files: child stdout/stderr not piped for ${file}\n`)
          try { child.kill('SIGKILL') } catch {}
          recordSpawnFailure(entry, file)
          continue
        }

        liveChildren.add(child)

        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')

        child.stdout.on('data', (data) => {
          handleStdoutChunk(entryIndex, data)
        })
        child.stderr.on('data', (data) => {
          handleStderrChunk(entryIndex, data)
        })

        child.on('message', (msg) => {
          const m = /** @type {unknown} */ (msg)
          if (isMochaRunFileResultMessage(m)) {
            entries[entryIndex].stats = {
              passes: m.passes || 0,
              failures: m.failures || 0,
              pending: m.pending || 0,
              tests: m.tests || 0,
              duration: m.duration || 0,
            }
          }
        })

        child.stdout.on('end', () => {
          if (entry.stdoutCarry) {
            // Append a newline so the leftover doesn't fragment the next file's output.
            handleStdoutLine(entryIndex, entry.stdoutCarry + '\n')
            entry.stdoutCarry = ''
          }
          entry.stdoutEnded = true
          maybeAdvanceActive()
        })

        child.stderr.on('end', () => {
          if (entry.stderrCarry) {
            handleStderrLine(entryIndex, entry.stderrCarry + '\n')
            entry.stderrCarry = ''
          }
          entry.stderrEnded = true
          maybeAdvanceActive()
        })

        // Async spawn failures (ENOENT, EAGAIN, EMFILE, AV blocking the binary
        // on Windows) arrive as 'error' instead of 'exit'. Without this handler
        // the EventEmitter contract turns the failure into an uncaught
        // exception and the parent crashes with no diagnostic.
        child.on('error', (err) => {
          process.stderr.write(`mocha-parallel-files: child error for ${file}: ${err.message}\n`)
          liveChildren.delete(child)
          if (entry.exited) return
          recordSpawnFailure(entry, file)
          safeLaunchNext()
          maybeAdvanceActive()
          checkDone()
        })

        child.on('exit', (code, signal) => {
          liveChildren.delete(child)
          if (entry.exited) return
          entry.exited = true
          entry.code = code
          entry.signal = signal
          running--
          if (code || signal) {
            failures++
            failed.push({ file, code, signal })
            process.exitCode = 1
          }

          safeLaunchNext()
          maybeAdvanceActive()
          checkDone()
        })
      }

      checkDone()
    }

    safeLaunchNext()
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
          const reset = '\u001B[0m'
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

  // Sharding is unconditional: writing to junitOutFile directly would let
  // later children overwrite earlier ones (e.g. when jobs === 1).
  if (emitJunit) {
    mergeXunitFilesToSingleTestsuite(junitTmpFiles.filter(f => fs.existsSync(f)), junitOutFile)
  }

  // Summary (always at the very end)
  let totalPasses = 0
  let totalFailures = 0
  let totalPending = 0
  let totalTests = 0
  let totalDuration = 0
  let crashedFiles = 0

  for (const entry of entries) {
    // If a child exited non-zero but never reported mocha stats (or reported 0 failures),
    // treat it as a "crash/harness failure" so summary reflects failure even when Mocha
    // couldn't produce a failing test count (e.g., hard crash, early process.exit()).
    if ((entry.code || entry.signal) && (!entry.stats || (entry.stats.failures || 0) === 0)) {
      crashedFiles++
    }

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
  process.stdout.write(`Failed: ${totalFailures + crashedFiles}\n`)
  process.stdout.write(`Pending: ${totalPending}\n`)
  process.stdout.write(`Total: ${totalTests}\n`)
  process.stdout.write(`Duration(ms): ${totalDuration}\n`)
  if (crashedFiles) process.stdout.write(`Crashed files: ${crashedFiles}\n`)

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
