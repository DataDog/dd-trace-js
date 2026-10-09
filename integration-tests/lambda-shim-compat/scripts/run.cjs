#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const images = require('../assets/images.json')
const { compare } = require('./compare.cjs')
const { gate } = require('./gate.cjs')

const assets = path.resolve(__dirname, '../assets')
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')

/** @param {string[]} argv */
function parseArgs (argv) {
  const options = { runtimes: '22', modes: 'normal,layer-only,preload', filter: '' }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--help') return { help: true }
    if (flag === '--ci') { options.ci = true; continue }
    assert.ok(/^--(candidate|output|runtimes|modes|control|filter|platform|tarball)$/.test(flag), `Unknown option: ${flag}`)
    const value = argv[++i]
    assert.ok(value && !value.startsWith('--'), `Missing value for ${flag}`)
    options[flag.slice(2)] = value
  }
  assert.ok(options.candidate, '--candidate is required')
  options.candidate = path.resolve(options.candidate)
  options.output = path.resolve(options.output || path.join(path.dirname(options.candidate), '.lambda-compat-runs',
    `${new Date().toISOString().replaceAll(':', '-')}-${crypto.randomBytes(3).toString('hex')}`))
  options.runtimes = options.runtimes.split(',')
  options.modes = options.modes.split(',')
  assert.ok(options.runtimes.every(n => /^(18|20|22|24|26)$/.test(n)), 'Supported runtime selections: 18,20,22,24,26')
  assert.ok(options.modes.every(m => ['normal', 'layer-only', 'preload'].includes(m)), 'Invalid mode')
  assert.equal(new Set(options.runtimes).size, options.runtimes.length, 'Duplicate runtime')
  assert.equal(new Set(options.modes).size, options.modes.length, 'Duplicate mode')
  if (options.control) assert.match(options.control, /^\d+\.\d+\.\d+$/, '--control must be an exact released version')
  if (options.ci) {
    assert.equal(options.filter, '', 'CI gate cannot use a filtered matrix')
    assert.deepEqual(options.modes, ['normal', 'layer-only', 'preload'], 'CI gate requires every mode')
    assert.equal(options.control, undefined, 'CI gate uses only the reviewed per-major control')
  }
  if (options.platform) assert.match(options.platform, /^linux\/(amd64|arm64)$/)
  const outputRelative = path.relative(options.candidate, options.output)
  assert.ok(outputRelative.startsWith('..' + path.sep) || path.isAbsolute(outputRelative),
    '--output must be outside the candidate checkout')
  return options
}

/** @param {string} [root] */
function checkAssets (root = assets) {
  const baseline = readJson(path.join(root, 'baseline.json'))
  for (const [file, sha] of [[baseline.shim.artifact, baseline.shim.sha256],
    ...[baseline.control, baseline.controlV5].map(control => [control.lockfile, control.lockSha256])]) {
    assert.equal(hash(fs.readFileSync(path.join(root, file))), sha, `Frozen baseline checksum mismatch: ${file}`)
  }
  return baseline
}

/**
 * @param {string} program
 * @param {string[]} args
 * @param {import('node:child_process').SpawnSyncOptionsWithStringEncoding} [options]
 */
function command (program, args, options = {}) {
  const result = spawnSync(program, args, {
    encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, timeout: 15 * 60 * 1000, ...options,
  })
  if (result.error || result.status !== 0) {
    throw new Error(`${program} ${args.slice(0, 3).join(' ')} failed (${result.status}):\n` +
      (result.error?.message || result.stderr || result.stdout))
  }
  return result.stdout.trim()
}

/**
 * @param {string[]} args
 * @param {string} log
 * @param {number[]} [accepted]
 */
function loggedCommand (args, log, accepted = [0]) {
  const fd = fs.openSync(log, 'wx')
  let result
  try {
    result = spawnSync('docker', args, { stdio: ['ignore', fd, fd], timeout: 15 * 60 * 1000 })
  } finally {
    fs.closeSync(fd)
  }
  assert.ok(!result.error && accepted.includes(result.status),
    `Docker command incomplete (status ${result.status}; ${result.error?.message || 'see log'}): ${log}`)
  return result.status
}

function fixtureDigest () {
  return hash(fs.readdirSync(path.join(assets, 'fixture')).sort().map(file =>
    `${file}:${hash(fs.readFileSync(path.join(assets, 'fixture', file)))}`).join('\n'))
}

/** @param {{outcome: string, candidate: object, shim: object, control: string, pairs: object[]}} summary */
function reportMarkdown (summary) {
  const lines = ['# Lambda shim compatibility', '', `Outcome: **${summary.outcome}**`, '',
    `Candidate: ${summary.candidate.version} at ${summary.candidate.commit}` +
      `${summary.candidate.dirty ? ' (dirty)' : ''}.`,
    `Frozen shim: ${summary.shim.version}, commit ${summary.shim.commit}. Control: ${summary.control}.`, '',
    '## Matrix', '', '| Runtime / mode | Candidate | Control | New failures | Changed failures |',
    '| --- | ---: | ---: | ---: | ---: |']
  for (const pair of summary.pairs) {
    const r = pair.comparison
    lines.push(`| ${pair.runtime} / ${pair.mode} | ${r.candidatePassed}/${r.total} | ` +
      `${r.controlPassed}/${r.total} | ${r.regressions.length} | ${r.changedFailures.length} |`)
  }
  for (const pair of summary.pairs) {
    lines.push('', `## ${pair.runtime} / ${pair.mode}`, '')
    const categories = ['regressions', 'changedFailures', 'sharedFailures', 'improvements', 'allowed', 'unexpected']
    for (const category of categories) {
      if (!pair.comparison[category]) continue
      lines.push(`${category}: ${pair.comparison[category].join(', ') || 'none'}`, '')
    }
  }
  lines.push('## Limits', '',
    'Shared assertion failures require mechanism review; they are not automatically proven unrelated.',
    'Strict mode fails on any candidate failure. CI mode allows only documented, exact shared baseline defects.',
    'PASS WITH KNOWN FAILURES is regression-gate evidence, not a claim of complete compatibility.',
    'This is a process-level behavioral check, not goldens, real AWS runtime/termination/streaming, native install,',
    'AppSec/profiler, or Datadog ingestion certification. The shim peer range is ' + summary.shim.peerRange + '.',
    'Review provenance.json for image IDs, architecture, dependency locks and packaged source identity.',
    'Any filter or partial runtime/mode selection limits coverage. Actual v5/v6 backports need their own runs.', '')
  return lines.join('\n')
}

/** @param {string[]} argv */
function main (argv) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log('Usage: node run.cjs --candidate PATH [--output NEW_PATH] [--runtimes 22,24,26]\n' +
      '  [--modes normal,layer-only,preload] [--filter SUBSTRING] [--control 6.15.0]\n' +
      '  [--platform linux/arm64|linux/amd64] [--tarball PREBUILT_TARBALL] [--ci]\n' +
      'Default: Node 22, all three modes, fresh released control. Exit: 0 pass, 1 test failures, 2 incomplete.\n' +
      'Requires Docker-shared output path; no golden updates or production checkout writes.')
    return 0
  }
  const baseline = checkAssets()
  const fixtureSha256 = fixtureDigest()
  const matrix = require(path.join(assets, 'fixture/matrix.cjs'))
  assert.ok(options.modes.some(mode => matrix.select(mode, options.filter).length), 'Filter selected zero cases')
  const pkg = readJson(path.join(options.candidate, 'package.json'))
  assert.equal(pkg.name, 'dd-trace', '--candidate must be a dd-trace package checkout')
  const major = Number(pkg.version.split('.')[0])
  assert.ok([5, 6, 7].includes(major), 'Select a reviewed control for the new tracer major')
  options.control ||= major === 5 ? baseline.controlV5.version : baseline.control.version
  assert.ok(!fs.existsSync(options.output), 'Output already exists; choose a fresh directory')
  assert.ok(!options.output.includes(','), 'Docker bind mount paths cannot contain commas')
  const git = args => command('git', ['-C', options.candidate, ...args])
  const commit = git(['rev-parse', 'HEAD'])
  const status = git(['status', '--porcelain=v1', '--untracked-files=all'])
  const diffSha256 = hash(git(['diff', 'HEAD', '--binary']))
  fs.mkdirSync(options.output, { recursive: true })
  console.log(`Output: ${options.output}`)
  const provenance = {
    schemaVersion: 1,
    started: new Date().toISOString(),
    options,
    baseline,
    fixtureSha256,
    candidate: { version: pkg.version, commit, dirty: !!status, status, diffSha256 },
    images: {},
    host: { node: process.version, platform: process.platform, architecture: process.arch },
  }
  const provenancePath = path.join(options.output, 'provenance.json')
  writeJson(provenancePath, provenance)
  try {
    command('docker', ['info', '--format', '{{.ServerVersion}}'])
    console.log(`Packing current dd-trace files (${commit.slice(0, 8)}${status ? ', dirty' : ''})`)
    const packed = options.tarball
      ? {
          filename: 'candidate.tgz',
          files: command('tar', ['-tzf', path.resolve(options.tarball)]).split('\n')
            .map(file => ({ path: file.replace(/^package\//, '') })).filter(file => !file.path.endsWith('/')),
        }
      : JSON.parse(command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', options.output],
        {
          cwd: options.candidate,
          env: { ...process.env, npm_config_cache: path.join(options.output, 'npm-cache') },
        }))[0]
    const tarball = path.join(options.output, packed.filename)
    if (options.tarball) fs.copyFileSync(path.resolve(options.tarball), tarball)
    provenance.candidate.tarballSha256 = hash(fs.readFileSync(tarball))
    const sourceHashes = {}
    const lambdaSource = /^packages\/(dd-trace\/src\/lambda\/|datadog-plugin-aws-lambda\/|datadog-instrumentations\/src\/aws-lambda)/
    for (const file of packed.files) {
      if (lambdaSource.test(file.path)) {
        const source = path.join(options.candidate, file.path)
        if (fs.statSync(source).isFile()) sourceHashes[file.path] = hash(fs.readFileSync(source))
      }
    }
    assert.ok(Object.keys(sourceHashes).length, 'No packaged Lambda sources; inspect package/build before testing')
    assert.equal(git(['status', '--porcelain=v1', '--untracked-files=all']), status, 'Checkout changed while packing')
    assert.equal(hash(git(['diff', 'HEAD', '--binary'])), diffSha256, 'Checkout changed while packing')
    provenance.candidate.sourceHashes = sourceHashes

    const platform = options.platform ? ['--platform', options.platform] : []
    const image = runtime => {
      if (provenance.images[runtime]) return provenance.images[runtime].Id
      const tag = images[runtime]
      let inspected
      try { inspected = JSON.parse(command('docker', ['image', 'inspect', tag]))[0] } catch {
        console.log(`Pulling runtime image ${tag}`)
        loggedCommand(['pull', ...platform, tag], path.join(options.output, `pull-${runtime}.log`))
        inspected = JSON.parse(command('docker', ['image', 'inspect', tag]))[0]
      }
      if (options.platform && `${inspected.Os}/${inspected.Architecture}` !== options.platform) {
        throw new Error(`Local ${tag} has a different platform; pull ${options.platform} explicitly and rerun`)
      }
      provenance.images[runtime] = {
        tag,
        Id: inspected.Id,
        RepoDigests: inspected.RepoDigests,
        Os: inspected.Os,
        Architecture: inspected.Architecture,
      }
      writeJson(provenancePath, provenance)
      return inspected.Id
    }
    const installImage = image(options.runtimes[0])
    for (const kind of ['candidate', 'control']) {
      const dir = path.join(options.output, kind)
      fs.mkdirSync(dir)
      fs.cpSync(path.join(assets, 'fixture'), dir, { recursive: true })
      fs.cpSync(path.join(assets, 'fixture'), path.join(dir, 'layer-task'), { recursive: true })
      fs.copyFileSync(path.join(assets, baseline.shim.artifact), path.join(dir, baseline.shim.artifact))
      if (kind === 'candidate') fs.copyFileSync(tarball, path.join(dir, packed.filename))
      const control = [baseline.control, baseline.controlV5].find(control => control.version === options.control)
      const lockedControl = kind === 'control' && control
      if (lockedControl) fs.copyFileSync(path.join(assets, control.lockfile), path.join(dir, 'yarn.lock'))
      writeJson(path.join(dir, 'package.json'), {
        name: `lambda-compat-${kind}`,
        version: '1.0.0',
        private: true,
        resolutions: options.control === baseline.controlV5.version ? baseline.controlV5.resolutions : undefined,
        dependencies: {
          'dd-trace': kind === 'candidate' ? `file:${packed.filename}` : options.control,
          'datadog-lambda-js': `file:${baseline.shim.artifact}`,
        },
      })
      const metadata = {
        version: kind === 'candidate' ? pkg.version : options.control,
        shimVersion: baseline.shim.version,
        shimSha256: baseline.shim.sha256,
        fixtureSha256,
        sourceHashes: kind === 'candidate' ? sourceHashes : {},
        enginesNode: kind === 'candidate' ? pkg.engines.node : undefined,
      }
      writeJson(path.join(dir, 'metadata.json'), metadata)
      writeJson(path.join(dir, 'layer-task/metadata.json'), metadata)
      console.log(`Installing ${kind} ${metadata.version} with frozen shim ${baseline.shim.version}`)
      loggedCommand(['run', '--rm', ...platform, '--mount', `type=bind,src=${dir},dst=/var/task`,
        '-w', '/var/task', '--entrypoint', 'yarn', installImage, 'install', '--non-interactive', '--ignore-scripts',
        '--network-timeout', '60000', ...(lockedControl ? ['--frozen-lockfile'] : [])],
      path.join(options.output, `install-${kind}.log`))
      provenance[kind + 'LockSha256'] = hash(fs.readFileSync(path.join(dir, 'yarn.lock')))
      loggedCommand(['run', '--rm', '--network', 'none', ...platform,
        '--mount', `type=bind,src=${dir},dst=/var/task,readonly`, '-w', '/var/task', '--entrypoint', 'node',
        installImage, '/var/task/verify.cjs'], path.join(options.output, `verify-${kind}.log`))
    }
    const summary = {
      outcome: 'PASS',
      candidate: provenance.candidate,
      shim: baseline.shim,
      control: options.control,
      pairs: [],
    }
    for (const runtime of options.runtimes) {
      const runtimeImage = image(runtime)
      for (const mode of options.modes) {
        if (!matrix.select(mode, options.filter).length) continue
        const reports = {}
        for (const kind of ['candidate', 'control']) {
          const dir = path.join(options.output, kind)
          const task = mode === 'layer-only' ? path.join(dir, 'layer-task') : dir
          const name = `${kind}-node${runtime}-${mode}`
          console.log(`Running ${name}${options.filter ? ` (filter: ${options.filter})` : ''}`)
          const code = loggedCommand(['run', '--rm', '--network', 'none', ...platform,
            '--mount', `type=bind,src=${task},dst=/var/task`,
            '--mount', `type=bind,src=${dir}/node_modules,dst=/opt/nodejs/node_modules,readonly`,
            '-w', '/var/task', '-e', `COMPAT_MODE=${mode}`, '-e', `COMPAT_FILTER=${options.filter}`,
            '--entrypoint', 'node', runtimeImage, '/var/task/run.cjs'],
          path.join(options.output, `${name}.log`), [0, 1])
          reports[kind] = readJson(path.join(task, `results-node${runtime}-${mode}.json`))
          const expectedVersion = kind === 'candidate' ? pkg.version : options.control
          assert.equal(reports[kind].tracerVersion, expectedVersion, 'Unexpected tracer report identity')
          const keys = rows => rows.map(row => `${row.entry}/${row.scenario}`).sort()
          assert.deepEqual(keys(reports[kind].rows), keys(matrix.select(mode, options.filter)),
            'Incomplete test matrix')
          assert.equal(reports[kind].fixtureSha256, fixtureSha256, 'Unexpected fixture identity')
          assert.equal(reports[kind].shimSha256, baseline.shim.sha256, 'Unexpected shim identity')
          assert.equal(code, reports[kind].rows.some(row => !row.passed) ? 1 : 0, 'Exit/report disagreement')
        }
        const comparison = options.ci
          ? gate(reports.candidate, reports.control)
          : compare(reports.candidate, reports.control)
        if (options.ci ? comparison.unexpected.length : comparison.candidatePassed !== comparison.total) {
          summary.outcome = 'FAIL'
        } else if (options.ci && comparison.allowed.length && summary.outcome !== 'FAIL') {
          summary.outcome = 'PASS WITH KNOWN FAILURES'
        }
        summary.pairs.push({ runtime: reports.candidate.runtime, mode, comparison })
        console.log(`${runtime}/${mode}: candidate ${comparison.candidatePassed}/${comparison.total}, ` +
          `control ${comparison.controlPassed}/${comparison.total}; ${comparison.regressions.length} new failures`)
      }
    }
    assert.ok(summary.pairs.length, 'Filter selected zero cases')
    assert.equal(fixtureDigest(), fixtureSha256, 'Fixtures changed during the run')
    checkAssets()
    provenance.finished = new Date().toISOString()
    writeJson(provenancePath, provenance)
    writeJson(path.join(options.output, 'summary.json'), summary)
    fs.writeFileSync(path.join(options.output, 'report.md'), reportMarkdown(summary))
    console.log(`${summary.outcome}: ${path.join(options.output, 'report.md')}`)
    return summary.outcome === 'FAIL' ? 1 : 0
  } catch (error) {
    provenance.incomplete = error.stack
    writeJson(provenancePath, provenance)
    writeJson(path.join(options.output, 'summary.json'), { outcome: 'INCOMPLETE', error: error.message })
    fs.writeFileSync(path.join(options.output, 'report.md'),
      `# Lambda shim compatibility\n\nOutcome: **INCOMPLETE**\n\n${error.message}\n`)
    throw error
  }
}

module.exports = { parseArgs, checkAssets, reportMarkdown, main }
if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)) } catch (error) {
    console.error(error.stack)
    process.exitCode = 2
  }
}
