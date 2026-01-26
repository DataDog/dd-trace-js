'use strict'

/**
 * Orchestrates the supported-configurations enrichment workflow.
 *
 * Steps:
 * - (optional) sync docs repo (DataDog/documentation)
 * - build docs evidence report
 * - rewrite supported-configurations.json (candidate merge)
 * - validate supported-configurations.json
 * - (optional) build provenance report
 * - (optional) run targeted config tests
 *
 * This is intentionally best-effort and offline-friendly:
 * - If docs repo isn't present and --sync-docs isn't passed, docs evidence will still run and just match nothing.
 * - Provenance may be approximate in partial clones (offline), see its report for details.
 */

const { execFileSync } = require('node:child_process')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..')

function runNode (scriptRelPath, args = [], extra = {}) {
  const scriptPath = path.join(REPO_ROOT, scriptRelPath)
  execFileSync(process.execPath, [scriptPath, ...args], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    ...extra
  })
}

function runMocha (args = []) {
  const mochaBin = path.join(REPO_ROOT, 'node_modules/.bin/mocha')
  execFileSync(mochaBin, args, { cwd: REPO_ROOT, stdio: 'inherit' })
}

function parseArgs () {
  const args = process.argv.slice(2)
  /** @type {{ syncDocs: boolean, docsDir: string | undefined, overwrite: boolean, emitAllCandidates: boolean, runProvenance: boolean, runTests: boolean }} */
  const out = {
    syncDocs: false,
    docsDir: undefined,
    overwrite: false,
    emitAllCandidates: false,
    runProvenance: false,
    runTests: false
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--sync-docs') out.syncDocs = true
    else if (a === '--docs-dir') out.docsDir = args[++i]
    else if (a === '--overwrite') out.overwrite = true
    else if (a === '--emit-all-candidates') out.emitAllCandidates = true
    else if (a === '--provenance') out.runProvenance = true
    else if (a === '--tests') out.runTests = true
  }
  return out
}

function main () {
  const argv = parseArgs()

  if (argv.syncDocs) {
    // requires network permissions when run in sandboxed environments
    runNode('scripts/sync-datadog-documentation.js')
  }

  runNode('scripts/docs-evidence-supported-configurations.js', argv.docsDir ? [argv.docsDir] : [])

  const rewriteArgs = []
  if (argv.overwrite) rewriteArgs.push('--overwrite')
  if (argv.emitAllCandidates) rewriteArgs.push('--emit-all-candidates')
  runNode('scripts/rewrite-config-supported-configurations.js', rewriteArgs)

  runNode('scripts/validate-config-supported-configurations.js')

  if (argv.runProvenance) {
    runNode('scripts/research-config-provenance.js', ['--all'])
  }

  if (argv.runTests) {
    runMocha(['packages/dd-trace/test/config/index.spec.js', '--grep', 'should initialize with the correct defaults'])
  }
}

if (require.main === module) {
  main()
}

