import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it } from 'mocha'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(dirname, '..')
const verifier = path.join(dirname, 'verify-exercised-tests.js')
const coverageAction = path.join(repoRoot, '.github/actions/coverage/action.yml')
const uploadAction = path.join(repoRoot, '.github/actions/upload-coverage-artifact/action.yml')
const verifierTimeoutMs = 5000

/**
 * @param {string} file
 * @param {string} contents
 * @returns {void}
 */
function writeFile (file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents)
}

/**
 * @param {string} steps
 * @returns {string}
 */
function createWorkflow (steps) {
  return `
name: test
on: push
env:
  WORKFLOW_ENV: workflow
  WORKFLOW_NUMBER: 1
jobs:
  coverage:
    runs-on: ubuntu-latest
    env:
      JOB_ENV: 1
      JOB_LABEL: job
    steps:
${steps}
`
}

/**
 * @param {string} workflow
 * @param {Record<string, string>} [files]
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runVerifier (workflow, files = {}) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-exercised-tests-'))

  try {
    writeFile(path.join(fixtureRoot, 'package.json'), '{"scripts":{}}\n')
    writeFile(path.join(fixtureRoot, '.github/workflows/test.yml'), workflow)
    writeFile(
      path.join(fixtureRoot, '.github/actions/coverage/action.yml'),
      fs.readFileSync(coverageAction, 'utf8')
    )
    writeFile(
      path.join(fixtureRoot, '.github/actions/upload-coverage-artifact/action.yml'),
      fs.readFileSync(uploadAction, 'utf8')
    )
    for (const [file, contents] of Object.entries(files)) {
      writeFile(path.join(fixtureRoot, file), contents)
    }

    const result = spawnSync(process.execPath, [verifier, fixtureRoot], {
      cwd: fixtureRoot,
      encoding: 'utf8',
      timeout: verifierTimeoutMs,
    })
    if (result.error) throw result.error
    return result
  } finally {
    fs.rmSync(fixtureRoot, { force: true, recursive: true })
  }
}

describe('verify-exercised-tests coverage uploads', () => {
  it('accepts a coverage producer followed by an uploader', () => {
    const result = runVerifier(createWorkflow(`
      - run: node scripts/c8-ci.js
      - uses: ./.github/actions/coverage
`))

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('accepts required commands around quoting, comments, and skipped control flow', () => {
    const result = runVerifier(createWorkflow(String.raw`
      - run: |
          echo "quoted\ value" # ignored command: npm run missing:ci
          if true; then
            if false; then
              npm run missing:ci
            fi
          fi
          node scripts/c8-ci.js
      - uses: ./.github/actions/coverage
`))

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('rejects a coverage producer after the last uploader', () => {
    const result = runVerifier(createWorkflow(`
      - uses: ./.github/actions/coverage
      - run: node scripts/c8-ci.js
`))

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /test\.yml#coverage: generates coverage but does not upload it/)
  })

  it('preserves producer-before-uploader order through nested composite actions', () => {
    const result = runVerifier(createWorkflow(`
      - if: github.ref == 'refs/heads/test'
        uses: ./.github/actions/test
`), {
      '.github/actions/test/action.yml': `
name: test
runs:
  using: composite
  steps:
    - if: false
      run: node scripts/c8-ci.js
      shell: bash
    - if: github.ref == 'refs/heads/test'
      run: node scripts/c8-ci.js
      shell: bash
    - uses: ./.github/actions/coverage
`,
    })

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('preserves uploader-before-producer order through nested composite actions', () => {
    const result = runVerifier(createWorkflow(`
      - uses: ./.github/actions/test
`), {
      '.github/actions/test/action.yml': `
name: test
runs:
  using: composite
  steps:
    - uses: ./.github/actions/coverage
    - run: node scripts/c8-ci.js
      shell: bash
`,
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /test\.yml#coverage: generates coverage but does not upload it/)
  })

  it('rejects opaque non-composite local actions', () => {
    const result = runVerifier(createWorkflow(`
      - uses: ./.github/actions/javascript
      - uses: ./.github/actions/docker
      - uses: nick-fields/retry@v4
`), {
      '.github/actions/javascript/action.yml': `
name: javascript
runs:
  using: node20
  main: index.js
`,
      '.github/actions/javascript/index.js': "'use strict'\n",
      '.github/actions/docker/action.yml': `
name: docker
runs:
  using: docker
  image: Dockerfile
`,
      '.github/actions/docker/Dockerfile': 'FROM scratch\n',
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /cannot inspect non-composite local action/)
  })

  it('rejects malformed local actions without runs metadata', () => {
    const result = runVerifier(createWorkflow(`
      - uses: ./.github/actions/malformed
      - uses: ./.github/actions/non-object
`), {
      '.github/actions/malformed/action.yml': 'name: malformed\n',
      '.github/actions/non-object/action.yml': '- invalid\n',
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /cannot inspect non-composite local action/)
  })

  it('stops expanding recursive composite actions', () => {
    const result = runVerifier(createWorkflow(`
      - uses: ./.github/actions/recursive
`), {
      '.github/actions/recursive/action.yml': `
name: recursive
runs:
  using: composite
  steps:
    - invalid
    - uses: ./.github/actions/recursive
`,
    })

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('rejects a coverage action that no longer reaches the uploader', () => {
    const result = runVerifier(createWorkflow(`
      - run: node scripts/c8-ci.js
      - uses: ./.github/actions/coverage
`), {
      '.github/actions/coverage/action.yml': `
name: coverage
runs:
  using: composite
  steps:
    - run: echo no upload
      shell: bash
`,
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /test\.yml#coverage: generates coverage but does not upload it/)
  })

  it('rejects an upload action that no longer uploads coverage', () => {
    const result = runVerifier(createWorkflow(`
      - run: node scripts/c8-ci.js
      - uses: ./.github/actions/coverage
`), {
      '.github/actions/upload-coverage-artifact/action.yml': `
name: upload
runs:
  using: composite
  steps:
    - run: echo no upload
      shell: bash
`,
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /test\.yml#coverage: generates coverage but does not upload it/)
  })

  it('rejects an upload action whose primary upload gains a stricter condition', () => {
    const result = runVerifier(createWorkflow(`
      - run: node scripts/c8-ci.js
      - uses: ./.github/actions/coverage
`), {
      '.github/actions/upload-coverage-artifact/action.yml': `
name: upload
runs:
  using: composite
  steps:
    - if: github.ref == 'refs/heads/test'
      uses: actions/upload-artifact@v4
      with:
        path: |
          \${{ inputs.report-dir }}/**/lcov.info
          \${{ inputs.report-dir }}/**/coverage-final.json
`,
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /test\.yml#coverage: generates coverage but does not upload it/)
  })

  it('rejects a conditional upload action without its coverage check', () => {
    const result = runVerifier(createWorkflow(`
      - run: node scripts/c8-ci.js
      - uses: ./.github/actions/coverage
`), {
      '.github/actions/upload-coverage-artifact/action.yml': `
name: upload
runs:
  using: composite
  steps:
    - if: github.actor != 'dependabot[bot]' && steps.check.outputs.has_coverage == 'true'
      uses: actions/upload-artifact@v4
      with:
        path: |
          \${{ inputs.report-dir }}/**/lcov.info
          \${{ inputs.report-dir }}/**/coverage-final.json
`,
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /test\.yml#coverage: generates coverage but does not upload it/)
  })

  it('rejects malformed upload action metadata', () => {
    const result = runVerifier(createWorkflow(`
      - run: node scripts/c8-ci.js
      - uses: ./.github/actions/coverage
`), {
      '.github/actions/upload-coverage-artifact/action.yml': 'name: upload\n',
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /test\.yml#coverage: generates coverage but does not upload it/)
  })

  it('rejects an upload action whose steps are not an array', () => {
    const result = runVerifier(createWorkflow(`
      - run: node scripts/c8-ci.js
      - uses: ./.github/actions/coverage
`), {
      '.github/actions/upload-coverage-artifact/action.yml': `
name: upload
runs:
  using: composite
  steps: invalid
`,
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /test\.yml#coverage: generates coverage but does not upload it/)
  })

  it('rejects an upload action without coverage paths', () => {
    const result = runVerifier(createWorkflow(`
      - run: node scripts/c8-ci.js
      - uses: ./.github/actions/coverage
`), {
      '.github/actions/upload-coverage-artifact/action.yml': `
name: upload
runs:
  using: composite
  steps:
    - uses: actions/upload-artifact@v4
`,
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /test\.yml#coverage: generates coverage but does not upload it/)
  })

  it('detects retry-wrapped coverage producers inside composite actions', () => {
    const result = runVerifier(createWorkflow(`
      - uses: ./.github/actions/test
`), {
      '.github/actions/test/action.yml': `
name: test
runs:
  using: composite
  steps:
    - uses: ./.github/actions/coverage
    - uses: nick-fields/retry@v4
    - uses: nick-fields/retry@v4
      env:
        RETRY_COUNT: 1
        RETRY_LABEL: retry
      with:
        command: |
          export COVERAGE_MODE=enabled
          PLUGINS=http yarn test && npm run test && node scripts/c8-ci.js
    - uses: nick-fields/retry@v4
      with:
        command: yarn test && node scripts/c8-ci.js
`,
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /test\.yml#coverage: generates coverage but does not upload it/)
  })

  it('rejects an uploader with an additional condition', () => {
    const result = runVerifier(createWorkflow(`
      - run: node scripts/c8-ci.js
      - if: false
        uses: ./.github/actions/coverage
`))

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /test\.yml#coverage: generates coverage but does not upload it/)
  })

  it('does not merge conditions that differ inside string literals', () => {
    const result = runVerifier(createWorkflow(`
      - if: contains(github.event.pull_request.title, 'run''s  coverage')
        run: node scripts/c8-ci.js
      - if: contains(github.event.pull_request.title, 'run''s coverage')
        uses: ./.github/actions/coverage
`))

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /test\.yml#coverage: generates coverage but does not upload it/)
  })

  it('rejects a success-only uploader for an always producer', () => {
    const result = runVerifier(createWorkflow(`
      - run: exit 1
      - if: always()
        run: node scripts/c8-ci.js
      - uses: ./.github/actions/coverage
`))

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /test\.yml#coverage: generates coverage but does not upload it/)
  })

  it('treats explicit and implicit success conditions equally', () => {
    const result = runVerifier(createWorkflow(`
      - run: node scripts/c8-ci.js
      - if: success()
        uses: ./.github/actions/coverage
`))

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('keeps conditions scoped to their composite action invocation', () => {
    const result = runVerifier(createWorkflow(`
      - uses: ./.github/actions/producer
        with:
          enabled: 'true'
      - uses: ./.github/actions/uploader
        with:
          enabled: 'false'
`), {
      '.github/actions/producer/action.yml': `
name: producer
inputs:
  enabled:
    required: true
runs:
  using: composite
  steps:
    - if: inputs.enabled == 'true'
      run: node scripts/c8-ci.js
      shell: bash
`,
      '.github/actions/uploader/action.yml': `
name: uploader
inputs:
  enabled:
    required: true
runs:
  using: composite
  steps:
    - if: inputs.enabled == 'true'
      uses: ./.github/actions/upload-coverage-artifact
`,
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /test\.yml#coverage: generates coverage but does not upload it/)
  })

  it('keeps conditions scoped to their step environment', () => {
    const result = runVerifier(createWorkflow(`
      - if: env.ENABLED == 'true'
        run: node scripts/c8-ci.js
        env:
          ENABLED: 'true'
      - if: env.ENABLED == 'true'
        uses: ./.github/actions/coverage
        env:
          ENABLED: 'false'
`))

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /test\.yml#coverage: generates coverage but does not upload it/)
  })

  it('ignores coverage producers with statically false conditions', () => {
    const result = runVerifier(createWorkflow(`
      - if: false
        run: node scripts/c8-ci.js
      - if: null
        run: node scripts/c8-ci.js
      - if: 0
        run: node scripts/c8-ci.js
      - if: "-0"
        run: node scripts/c8-ci.js
      - if: ''
        run: node scripts/c8-ci.js
`))

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('accepts coverage producers with statically true conditions', () => {
    const result = runVerifier(createWorkflow(`
      - if: true
        run: node scripts/c8-ci.js
      - if: \${{ true }}
        run: node scripts/c8-ci.js
      - uses: ./.github/actions/coverage
`))

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('ignores a coverage producer in a job that cannot run', () => {
    const result = runVerifier(`
name: test
on: push
jobs:
  coverage:
    if: false
    runs-on: ubuntu-latest
    steps:
      - run: node scripts/c8-ci.js
`)

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('accepts an uploader guarded by the producer condition', () => {
    const result = runVerifier(createWorkflow(`
      - if: \${{ github.ref == 'refs/heads/test' }}
        run: node scripts/c8-ci.js
      - if: \${{ github.ref == 'refs/heads/test' }}
        uses: ./.github/actions/coverage
`))

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('matches separate uploaders to each conditional producer', () => {
    const result = runVerifier(createWorkflow(`
      - if: github.ref == 'refs/heads/first'
        run: node scripts/c8-ci.js
      - if: github.ref == 'refs/heads/second'
        run: node scripts/c8-ci.js
      - if: github.ref == 'refs/heads/first'
        uses: ./.github/actions/coverage
      - if: github.ref == 'refs/heads/second'
        uses: ./.github/actions/coverage
`))

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('accepts an unconditional uploader after a conditional producer', () => {
    const result = runVerifier(createWorkflow(`
      - if: github.ref == 'refs/heads/test'
        run: node scripts/c8-ci.js
      - uses: ./.github/actions/coverage
`))

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('recognizes a normalized uploader action path', () => {
    const result = runVerifier(createWorkflow(`
      - run: node scripts/c8-ci.js
      - uses: ./.github/actions/upload-coverage-artifact/
`))

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('does not count matrix values excluded from the workflow', () => {
    const result = runVerifier(`
name: test
on: push
jobs:
  coverage:
    strategy:
      matrix:
        spec: [first, omitted]
        exclude:
          - spec: omitted
    runs-on: ubuntu-latest
    steps:
      - run: npm run test:fixture:ci
        env:
          SPEC: \${{ matrix.spec }}
      - uses: ./.github/actions/coverage
`, {
      'package.json': JSON.stringify({
        scripts: {
          'test:fixture': 'mocha "test/$' + '{SPEC:-*}.spec.js"',
          'test:fixture:ci': 'node scripts/c8-ci.js test:fixture',
        },
      }),
      'test/first.spec.js': "'use strict'\n",
      'test/omitted.spec.js': "'use strict'\n",
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /No CI workflow invocation expands a glob to exercise test\/omitted\.spec\.js/)
  })

  it('expands include-only matrix values in step environments', () => {
    const result = runVerifier(`
name: test
on: push
jobs:
  coverage:
    strategy:
      matrix:
        include:
          - spec: first
          - spec: second
    runs-on: ubuntu-latest
    steps:
      - run: npm run test:fixture:ci
        env:
          SPEC: \${{ matrix.spec }}
      - uses: ./.github/actions/coverage
`, {
      'package.json': JSON.stringify({
        scripts: {
          'test:fixture': 'mocha "test/$' + '{SPEC:-*}.spec.js"',
          'test:fixture:ci': 'node scripts/c8-ci.js test:fixture',
        },
      }),
      'test/first.spec.js': "'use strict'\n",
      'test/second.spec.js': "'use strict'\n",
    })

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('allows include entries to reintroduce excluded matrix values', () => {
    const result = runVerifier(`
name: test
on: push
jobs:
  coverage:
    strategy:
      matrix:
        spec: [first, second]
        exclude:
          - spec: second
        include:
          - spec: second
    runs-on: ubuntu-latest
    steps:
      - run: npm run test:fixture:ci
        env:
          SPEC: \${{ matrix.spec }}
      - uses: ./.github/actions/coverage
`, {
      'package.json': JSON.stringify({
        scripts: {
          'test:fixture': 'mocha "test/$' + '{SPEC:-*}.spec.js"',
          'test:fixture:ci': 'node scripts/c8-ci.js test:fixture',
        },
      }),
      'test/first.spec.js': "'use strict'\n",
      'test/second.spec.js': "'use strict'\n",
    })

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('expands nested matrix values in step environments', () => {
    const result = runVerifier(`
name: test
on: push
jobs:
  coverage:
    strategy:
      matrix:
        target:
          - spec: first
    runs-on: ubuntu-latest
    steps:
      - run: npm run test:fixture:ci
        env:
          SPEC: \${{ matrix.target.spec }}
      - uses: ./.github/actions/coverage
`, {
      'package.json': JSON.stringify({
        scripts: {
          'test:fixture': 'mocha "test/$' + '{SPEC:-*}.spec.js"',
          'test:fixture:ci': 'node scripts/c8-ci.js test:fixture',
        },
      }),
      'test/first.spec.js': "'use strict'\n",
      'test/omitted.spec.js': "'use strict'\n",
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /No CI workflow invocation expands a glob to exercise test\/omitted\.spec\.js/)
  })

  it('applies matrix includes without modifying standalone combinations', () => {
    const result = runVerifier(`
name: test
on: push
jobs:
  coverage:
    strategy:
      matrix:
        spec: [1, 1]
        nullable: [null]
        include:
          - spec: 2
          - flavor: included
    runs-on: ubuntu-latest
    env:
      STATIC_BOOLEAN: true
    steps:
      - invalid
      - run: npm run test:fixture:ci
        env:
          SPEC: \${{ matrix.spec }}
          NULLABLE: \${{ matrix.nullable }}
      - uses: ./.github/actions/coverage
`, {
      'package.json': JSON.stringify({
        scripts: {
          'test:fixture': 'mocha "test/$' + '{SPEC:-*}.spec.js"',
          'test:fixture:ci': 'node scripts/c8-ci.js test:fixture',
        },
      }),
      'test/1.spec.js': "'use strict'\n",
      'test/2.spec.js': "'use strict'\n",
    })

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('fails closed when a nested matrix path cannot be resolved', () => {
    const result = runVerifier(`
name: test
on: push
jobs:
  coverage:
    strategy:
      matrix:
        target:
          - spec: first
    runs-on: ubuntu-latest
    steps:
      - run: npm run test:fixture:ci
        env:
          SPEC: \${{ matrix.target.missing }}
      - uses: ./.github/actions/coverage
`, {
      'package.json': JSON.stringify({
        scripts: {
          'test:fixture': 'mocha "test/$' + '{SPEC:-*}.spec.js"',
          'test:fixture:ci': 'node scripts/c8-ci.js test:fixture',
        },
      }),
      'test/first.spec.js': "'use strict'\n",
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /"test:fixture:ci" would match 0 test files/)
  })

  it('does not count package scripts mentioned only in shell comments', () => {
    const result = runVerifier(createWorkflow(`
      - run: '# npm run test:fixture:ci'
      - uses: ./.github/actions/coverage
`), {
      'package.json': JSON.stringify({
        scripts: {
          'test:fixture': 'mocha "test/*.spec.js"',
          'test:fixture:ci': 'node scripts/c8-ci.js test:fixture',
        },
      }),
      'test/fixture.spec.js': "'use strict'\n",
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /script "test:fixture:ci" is not invoked/)
  })

  it('does not count package scripts passed as arguments to another command', () => {
    const result = runVerifier(createWorkflow(`
      - run: echo npm run test:fixture:ci
      - uses: ./.github/actions/coverage
`), {
      'package.json': JSON.stringify({
        scripts: {
          'test:fixture': 'mocha "test/*.spec.js"',
          'test:fixture:ci': 'node scripts/c8-ci.js test:fixture',
        },
      }),
      'test/fixture.spec.js': "'use strict'\n",
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /script "test:fixture:ci" is not invoked/)
  })

  it('does not count package scripts after an unconditional exit', () => {
    const result = runVerifier(createWorkflow(`
      - run: |
          exit 0
          npm run test:fixture:ci
      - uses: ./.github/actions/coverage
`), {
      'package.json': JSON.stringify({
        scripts: {
          'test:fixture': 'mocha "test/*.spec.js"',
          'test:fixture:ci': 'node scripts/c8-ci.js test:fixture',
        },
      }),
      'test/fixture.spec.js': "'use strict'\n",
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /script "test:fixture:ci" is not invoked/)
  })

  it('does not count package scripts in optional shell branches', () => {
    const result = runVerifier(createWorkflow(`
      - run: false && npm run test:fixture:ci || true
      - uses: ./.github/actions/coverage
`), {
      'package.json': JSON.stringify({
        scripts: {
          'test:fixture': 'mocha "test/*.spec.js"',
          'test:fixture:ci': 'node scripts/c8-ci.js test:fixture',
        },
      }),
      'test/fixture.spec.js': "'use strict'\n",
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /script "test:fixture:ci" is not invoked/)
  })

  it('does not count package scripts in multiline optional shell branches', () => {
    const result = runVerifier(createWorkflow(String.raw`
      - run: |
          false && \
            npm run test:fixture:ci \
            || true
      - uses: ./.github/actions/coverage
`), {
      'package.json': JSON.stringify({
        scripts: {
          'test:fixture': 'mocha "test/*.spec.js"',
          'test:fixture:ci': 'node scripts/c8-ci.js test:fixture',
        },
      }),
      'test/fixture.spec.js': "'use strict'\n",
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /script "test:fixture:ci" is not invoked/)
  })

  it('does not count package scripts after a mid-line exit', () => {
    const result = runVerifier(createWorkflow(`
      - run: echo setup && exit 0; npm run test:fixture:ci
      - uses: ./.github/actions/coverage
`), {
      'package.json': JSON.stringify({
        scripts: {
          'test:fixture': 'mocha "test/*.spec.js"',
          'test:fixture:ci': 'node scripts/c8-ci.js test:fixture',
        },
      }),
      'test/fixture.spec.js': "'use strict'\n",
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /script "test:fixture:ci" is not invoked/)
  })

  it('does not count package scripts started as background work', () => {
    const result = runVerifier(createWorkflow(`
      - run: npm run test:fixture:ci & true
      - uses: ./.github/actions/coverage
`), {
      'package.json': JSON.stringify({
        scripts: {
          'test:fixture': 'mocha "test/*.spec.js"',
          'test:fixture:ci': 'node scripts/c8-ci.js test:fixture',
        },
      }),
      'test/fixture.spec.js': "'use strict'\n",
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /script "test:fixture:ci" is not invoked/)
  })

  it('does not count package scripts in heredoc contents', () => {
    const result = runVerifier(createWorkflow(`
      - run: |
          cat <<'EOF'
          npm run test:fixture:ci
          EOF
      - uses: ./.github/actions/coverage
`), {
      'package.json': JSON.stringify({
        scripts: {
          'test:fixture': 'mocha "test/*.spec.js"',
          'test:fixture:ci': 'node scripts/c8-ci.js test:fixture',
        },
      }),
      'test/fixture.spec.js': "'use strict'\n",
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /script "test:fixture:ci" is not invoked/)
  })

  it('does not count package scripts in uncalled shell functions', () => {
    const result = runVerifier(createWorkflow(`
      - run: |
          run_tests() {
            npm run test:fixture:ci
          }
          true
      - uses: ./.github/actions/coverage
`), {
      'package.json': JSON.stringify({
        scripts: {
          'test:fixture': 'mocha "test/*.spec.js"',
          'test:fixture:ci': 'node scripts/c8-ci.js test:fixture',
        },
      }),
      'test/fixture.spec.js': "'use strict'\n",
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /script "test:fixture:ci" is not invoked/)
  })

  it('does not count package scripts after exec replaces the shell', () => {
    const result = runVerifier(createWorkflow(`
      - run: exec true; npm run test:fixture:ci
      - uses: ./.github/actions/coverage
`), {
      'package.json': JSON.stringify({
        scripts: {
          'test:fixture': 'mocha "test/*.spec.js"',
          'test:fixture:ci': 'node scripts/c8-ci.js test:fixture',
        },
      }),
      'test/fixture.spec.js': "'use strict'\n",
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /script "test:fixture:ci" is not invoked/)
  })

  it('does not widen unresolved workflow expressions to every test file', () => {
    const result = runVerifier(createWorkflow(`
      - run: npm run test:fixture:ci
        env:
          SPEC: \${{ matrix.spec || 'first' }}
      - uses: ./.github/actions/coverage
`), {
      'package.json': JSON.stringify({
        scripts: {
          'test:fixture': 'mocha "test/$' + '{SPEC:-*}.spec.js"',
          'test:fixture:ci': 'node scripts/c8-ci.js test:fixture',
        },
      }),
      'test/first.spec.js': "'use strict'\n",
      'test/omitted.spec.js': "'use strict'\n",
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /"test:fixture:ci" would match 0 test files/)
  })

  it('uses shell defaults for unset test-selection environment variables', () => {
    const result = runVerifier(createWorkflow(`
      - run: npm run test:fixture:ci
      - uses: ./.github/actions/coverage
`), {
      'package.json': JSON.stringify({
        scripts: {
          'test:fixture': 'mocha "test/$' + '{SPEC:-*}.spec.js"',
          'test:fixture:ci': 'node scripts/c8-ci.js test:fixture',
        },
      }),
      'test/first.spec.js': "'use strict'\n",
      'test/second.spec.js': "'use strict'\n",
    })

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('expands unbraced test-selection environment variables', () => {
    const result = runVerifier(createWorkflow(`
      - run: npm run test:fixture:ci
        env:
          SPEC: first
      - uses: ./.github/actions/coverage
`), {
      'package.json': JSON.stringify({
        scripts: {
          'test:fixture': 'mocha "test/$SPEC*.spec.js"',
          'test:fixture:ci': 'node scripts/c8-ci.js test:fixture',
        },
      }),
      'test/first.spec.js': "'use strict'\n",
      'test/omitted.spec.js': "'use strict'\n",
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /No CI workflow invocation expands a glob to exercise test\/omitted\.spec\.js/)
  })

  it('fails closed for unset unbraced environment variables', () => {
    const result = runVerifier(createWorkflow(`
      - run: npm run test:fixture:ci
      - uses: ./.github/actions/coverage
`), {
      'package.json': JSON.stringify({
        scripts: {
          'test:fixture': 'mocha "test/$SPEC*.spec.js"',
          'test:fixture:ci': 'node scripts/c8-ci.js test:fixture',
        },
      }),
      'test/fixture.spec.js': "'use strict'\n",
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /"test:fixture:ci" would match 0 test files/)
  })

  it('fails closed for empty plugin selections', () => {
    const result = runVerifier(createWorkflow(`
      - run: npm run test:fixture:ci
        env:
          PLUGINS: '|'
      - uses: ./.github/actions/coverage
`), {
      'package.json': JSON.stringify({
        scripts: {
          'test:fixture': 'mocha "packages/datadog-plugin-@($' + '{PLUGINS})/test/*.spec.js"',
          'test:fixture:ci': 'node scripts/c8-ci.js test:fixture',
        },
      }),
      'packages/datadog-plugin-fixture/test/index.spec.js': "'use strict'\n",
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /"test:fixture:ci" would match 0 test files/)
  })

  it('keeps inline environments scoped to each workflow command', () => {
    const result = runVerifier(createWorkflow(`
      - run: |
          PLUGINS=first npm run test:fixture:ci
          PLUGINS=second npm run test:fixture:ci
      - uses: ./.github/actions/coverage
`), {
      'package.json': JSON.stringify({
        scripts: {
          'test:fixture': 'mocha "packages/datadog-plugin-@($' + '{PLUGINS})/test/*.spec.js"',
          'test:fixture:ci': 'node scripts/c8-ci.js test:fixture',
        },
      }),
      'packages/datadog-plugin-first/test/index.spec.js': "'use strict'\n",
      'packages/datadog-plugin-second/test/index.spec.js': "'use strict'\n",
    })

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('tracks assignments passed through the env command', () => {
    const result = runVerifier(createWorkflow(`
      - run: env PLUGINS=fixture npm run test:fixture:ci
      - uses: ./.github/actions/coverage
`), {
      'package.json': JSON.stringify({
        scripts: {
          'test:fixture': 'mocha "packages/datadog-plugin-@($' + '{PLUGINS})/test/*.spec.js"',
          'test:fixture:ci': 'node scripts/c8-ci.js test:fixture',
        },
      }),
      'packages/datadog-plugin-fixture/test/index.spec.js': "'use strict'\n",
    })

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('tracks assignments around command and env wrappers', () => {
    const result = runVerifier(createWorkflow(`
      - run: PLUGINS=fixture command env MODE=test npm run test:fixture:ci
      - uses: ./.github/actions/coverage
`), {
      'package.json': JSON.stringify({
        scripts: {
          'test:fixture': 'mocha "packages/datadog-plugin-@($' + '{PLUGINS})/test/*.spec.js"',
          'test:fixture:ci': 'node scripts/c8-ci.js test:fixture',
        },
      }),
      'packages/datadog-plugin-fixture/test/index.spec.js': "'use strict'\n",
    })

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('does not leak inline environments into later workflow commands', () => {
    const result = runVerifier(createWorkflow(`
      - run: |
          PLUGINS=first echo setup
          npm run test:fixture:ci
      - uses: ./.github/actions/coverage
`), {
      'package.json': JSON.stringify({
        scripts: {
          'test:fixture': 'mocha "packages/datadog-plugin-@($' + '{PLUGINS})/test/*.spec.js"',
          'test:fixture:ci': 'node scripts/c8-ci.js test:fixture',
        },
      }),
      'packages/datadog-plugin-first/test/index.spec.js': "'use strict'\n",
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /"test:fixture:ci" would match 0 test files/)
  })

  it('preserves distinct inline environments through nested package scripts', () => {
    const result = runVerifier(createWorkflow(`
      - run: npm run test:fixture:ci
      - uses: ./.github/actions/coverage
`), {
      'package.json': JSON.stringify({
        scripts: {
          'test:fixture': 'mocha "packages/datadog-plugin-@($' + '{PLUGINS})/test/*.spec.js"',
          'test:fixture:ci':
            'PLUGINS=first npm run test:fixture && PLUGINS=second npm run test:fixture && ' +
            'PLUGINS=first npm run test:fixture',
        },
      }),
      'packages/datadog-plugin-first/test/index.spec.js': "'use strict'\n",
      'packages/datadog-plugin-second/test/index.spec.js': "'use strict'\n",
    })

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('fails closed for unsupported shell parameter expansion', () => {
    const result = runVerifier(createWorkflow(`
      - run: npm run test:fixture:ci
        env:
          SPEC: first
      - uses: ./.github/actions/coverage
`), {
      'package.json': JSON.stringify({
        scripts: {
          'test:fixture': 'mocha "test/$' + '{SPEC/first/other}.spec.js"',
          'test:fixture:ci': 'node scripts/c8-ci.js test:fixture',
        },
      }),
      'test/fixture.spec.js': "'use strict'\n",
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /"test:fixture:ci" would match 0 test files/)
  })

  it('does not count test globs after an unconditional exit in a package script', () => {
    const result = runVerifier(createWorkflow(`
      - run: npm run test:fixture:ci
`), {
      'package.json': JSON.stringify({
        scripts: {
          'test:fixture': 'exit 0\nmocha "test/*.spec.js"',
          'test:fixture:ci': 'node scripts/c8-ci.js test:fixture',
        },
      }),
      'test/fixture.spec.js': "'use strict'\n",
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /Test files not covered by any package\.json script glob/)
  })

  it('defaults the repository root when invoked without an argument', () => {
    const result = spawnSync(process.execPath, [verifier], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: verifierTimeoutMs,
    })
    if (result.error) throw result.error

    assert.strictEqual(result.status, 0, result.stderr)
  })
}).timeout(verifierTimeoutMs * 2)
