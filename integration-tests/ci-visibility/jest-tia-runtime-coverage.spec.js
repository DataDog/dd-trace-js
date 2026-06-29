'use strict'

const assert = require('node:assert/strict')
const { exec } = require('node:child_process')
const { once } = require('node:events')

const {
  getCiVisAgentlessConfig,
  sandboxCwd,
  useSandbox,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')

const FIXTURE_ROOT = 'ci-visibility/jest-tia-runtime-coverage'
const MINIMUM_JEST_VERSION = '28.0.0'

const JEST_VERSION_CONFIGS = [
  {
    version: 'latest',
    dependencies: ['jest', 'typescript'],
  },
  {
    version: MINIMUM_JEST_VERSION,
    dependencies: [`jest@${MINIMUM_JEST_VERSION}`, `jest-circus@${MINIMUM_JEST_VERSION}`, 'typescript'],
  },
]

const EXPECTED_SUITE_COVERAGE = {
  [`${FIXTURE_ROOT}/__tests__/alpha.spec.js`]: [
    `${FIXTURE_ROOT}/__tests__/alpha.spec.js`,
    `${FIXTURE_ROOT}/src/branch.js`,
    `${FIXTURE_ROOT}/src/lazy.js`,
    `${FIXTURE_ROOT}/src/math.js`,
    `${FIXTURE_ROOT}/src/passive.js`,
    `${FIXTURE_ROOT}/src/shared.js`,
    `${FIXTURE_ROOT}/src/side-effect.js`,
    `${FIXTURE_ROOT}/src/throws-on-import.js`,
  ],
  [`${FIXTURE_ROOT}/__tests__/beta.spec.js`]: [
    `${FIXTURE_ROOT}/__tests__/beta.spec.js`,
    `${FIXTURE_ROOT}/src/branch.js`,
    `${FIXTURE_ROOT}/src/manual-target.js`,
  ],
  [`${FIXTURE_ROOT}/__tests__/gamma.spec.js`]: [
    `${FIXTURE_ROOT}/__tests__/gamma.spec.js`,
    `${FIXTURE_ROOT}/src/aggregator.js`,
    `${FIXTURE_ROOT}/src/math.js`,
    `${FIXTURE_ROOT}/src/shared.js`,
  ],
  [`${FIXTURE_ROOT}/__tests__/delta-esm.spec.mjs`]: [
    `${FIXTURE_ROOT}/__tests__/delta-esm.spec.mjs`,
    `${FIXTURE_ROOT}/esm/entry.mjs`,
    `${FIXTURE_ROOT}/esm/lazy-esm.mjs`,
    `${FIXTURE_ROOT}/esm/nested-esm.mjs`,
    `${FIXTURE_ROOT}/esm/shared-esm.mjs`,
    `${FIXTURE_ROOT}/src/math.js`,
  ],
  [`${FIXTURE_ROOT}/__tests__/theta-typescript.spec.ts`]: [
    `${FIXTURE_ROOT}/__tests__/theta-typescript.spec.ts`,
    `${FIXTURE_ROOT}/ts/ts-branch.ts`,
    `${FIXTURE_ROOT}/ts/ts-entry.ts`,
    `${FIXTURE_ROOT}/ts/ts-shared.ts`,
  ],
}

for (const suiteCoverage of Object.values(EXPECTED_SUITE_COVERAGE)) {
  suiteCoverage.sort()
}

function getCoverageEvents (payloads) {
  return payloads
    .flatMap(({ payload }) => payload)
    .flatMap(({ content }) => content.coverages)
}

function getFilename (file) {
  return file.filename
}

function getSuiteCoverageBySuiteFile (coverages) {
  const coverageBySuite = {}

  for (const coverage of coverages) {
    if (!coverage.test_suite_id) continue

    const filenames = coverage.files.map(getFilename).sort()
    const suiteFile = filenames.find(filename =>
      filename.startsWith(`${FIXTURE_ROOT}/__tests__/`) &&
      filename.includes('.spec.')
    )

    assert.ok(suiteFile, `suite coverage should include its test file: ${filenames.join(', ')}`)
    coverageBySuite[suiteFile] = filenames
  }

  return coverageBySuite
}

function getBitmapFilenames (coverages) {
  return coverages
    .flatMap(coverage => coverage.files)
    .filter(file => file.bitmap)
    .map(getFilename)
    .sort()
}

function describeJestVersion ({ version, dependencies }) {
  describe(`Jest TIA runtime coverage engine jest@${version}`, function () {
    let cwd
    let childProcess

    this.timeout(180_000)

    useSandbox(dependencies, true)

    before(() => {
      cwd = sandboxCwd()
    })

    afterEach(() => {
      if (childProcess?.exitCode === null) {
        childProcess.kill()
      }
    })

    async function runFixture ({ enableUserCoverage = false } = {}) {
      const receiver = await new FakeCiVisIntake().start()
      receiver.setSettings({
        itr_enabled: true,
        code_coverage: true,
        coverage_report_upload_enabled: false,
        tests_skipping: false,
      })

      let output = ''
      let coverages
      const coveragePromise = receiver.gatherPayloadsMaxTimeout(
        ({ url }) => url.endsWith('/api/v2/citestcov'),
        payloads => {
          coverages = getCoverageEvents(payloads)
        }
      )
      const eventsPromise = receiver.gatherPayloadsMaxTimeout(
        ({ url }) => url.endsWith('/api/v2/citestcycle'),
        payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          assert.ok(events.find(event => event.type === 'test_session_end'), `missing session event:\n${output}`)
        }
      )

      const startTime = Date.now()
      childProcess = exec(
        'node ./ci-visibility/run-jest.js',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            NODE_OPTIONS: '--experimental-vm-modules -r dd-trace/ci/init',
            USE_JEST_RUN: '1',
            USE_CONFIG_FILE: '1',
            CONFIG_TEST_MATCH: `**/${FIXTURE_ROOT}/__tests__/*.spec.*`,
            CONFIG_TRANSFORM: JSON.stringify({
              '^.+\\.tsx?$': `<rootDir>/${FIXTURE_ROOT}/ts-transformer.cjs`,
            }),
            SHOULD_CHECK_RESULTS: '1',
            OTEL_TRACES_EXPORTER: '',
            OTEL_LOGS_EXPORTER: '',
            OTEL_METRICS_EXPORTER: '',
            ...(enableUserCoverage ? { ENABLE_CODE_COVERAGE: '1', COVERAGE_REPORTERS: 'none' } : {}),
          },
        }
      )
      childProcess.stdout?.on('data', chunk => {
        output += chunk.toString()
      })
      childProcess.stderr?.on('data', chunk => {
        output += chunk.toString()
      })

      try {
        const [, , [exitCode]] = await Promise.all([
          coveragePromise,
          eventsPromise,
          once(childProcess, 'exit'),
        ])
        assert.strictEqual(exitCode, 0, output)

        return {
          coverages,
          durationMs: Date.now() - startTime,
          suiteCoverage: getSuiteCoverageBySuiteFile(coverages),
        }
      } finally {
        await receiver.stop()
      }
    }

    it('matches legacy Istanbul per-suite touched files without forcing Jest coverage', async () => {
      const legacy = await runFixture({ enableUserCoverage: true })
      const runtime = await runFixture()

      assert.deepStrictEqual(legacy.suiteCoverage, EXPECTED_SUITE_COVERAGE)
      assert.deepStrictEqual(runtime.suiteCoverage, EXPECTED_SUITE_COVERAGE)
      assert.deepStrictEqual(runtime.suiteCoverage, legacy.suiteCoverage)
      assert.ok(
        getBitmapFilenames(legacy.coverages).includes(`${FIXTURE_ROOT}/src/math.js`),
        'legacy Istanbul coverage should include line bitmaps for covered source files'
      )
      assert.deepStrictEqual(getBitmapFilenames(runtime.coverages), [])
      assert.ok(
        runtime.durationMs < legacy.durationMs * 2,
        `runtime coverage took ${runtime.durationMs}ms and legacy took ${legacy.durationMs}ms`
      )
    })
  })
}

for (const jestVersionConfig of JEST_VERSION_CONFIGS) {
  describeJestVersion(jestVersionConfig)
}
