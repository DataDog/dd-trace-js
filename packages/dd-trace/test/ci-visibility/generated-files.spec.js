'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  cleanupGeneratedFiles,
  writeGeneratedFiles,
} = require('../../../../ci/test-optimization-validation/generated-files')

describe('test optimization validation generated files', () => {
  it('allows existing generated files when the content matches', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-generated-files-'))
    const filename = path.join(root, 'dd-test-optimization-validation.test.js')
    const framework = getFramework(root, filename)

    try {
      assert.deepStrictEqual(writeGeneratedFiles(framework), [filename])
      assert.deepStrictEqual(writeGeneratedFiles(framework), [])
      assert.strictEqual(
        fs.readFileSync(filename, 'utf8'),
        'describe("generated", function () {\n  it("passes", function () {})\n})\n'
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses to overwrite existing generated files with different content', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-generated-files-'))
    const filename = path.join(root, 'dd-test-optimization-validation.test.js')
    fs.writeFileSync(filename, 'existing\n')

    try {
      assert.throws(() => writeGeneratedFiles(getFramework(root, filename)), {
        message: /Refusing to overwrite existing generated validation file with different content/,
      })
      assert.strictEqual(fs.readFileSync(filename, 'utf8'), 'existing\n')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not clean matching generated files that were not written by this run', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-generated-files-'))
    const filename = path.join(root, 'dd-test-optimization-validation.test.js')
    const content = 'describe("generated", function () {\n  it("passes", function () {})\n})\n'
    fs.writeFileSync(filename, content)

    try {
      const framework = getFramework(root, filename)

      assert.deepStrictEqual(writeGeneratedFiles(framework), [])
      cleanupGeneratedFiles({ frameworks: [framework] })

      assert.strictEqual(fs.readFileSync(filename, 'utf8'), content)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses generated file paths outside the project root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-generated-files-'))
    const outside = path.join(os.tmpdir(), 'dd-test-optimization-validation-outside.test.js')

    try {
      assert.throws(() => writeGeneratedFiles(getFramework(root, outside)), {
        message: /outside project root/,
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(outside, { force: true })
    }
  })

  it('only cleans generated files and namespaced runtime files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-generated-files-'))
    const generated = path.join(root, 'dd-test-optimization-validation.test.js')
    const state = path.join(root, '.dd-test-optimization-validation-state')
    const unrelated = path.join(root, 'keep-me.txt')
    const framework = getFramework(root, generated, [generated, state, unrelated])

    try {
      writeGeneratedFiles(framework)
      fs.writeFileSync(state, 'state\n')
      fs.writeFileSync(unrelated, 'customer data\n')

      cleanupGeneratedFiles({ frameworks: [framework] })

      assert.strictEqual(fs.existsSync(generated), false)
      assert.strictEqual(fs.existsSync(state), false)
      assert.strictEqual(fs.readFileSync(unrelated, 'utf8'), 'customer data\n')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

function getFramework (root, filename, cleanupPaths = [filename]) {
  return {
    id: 'mocha:root',
    project: { root },
    generatedTestStrategy: {
      status: 'verified',
      files: [
        {
          path: filename,
          contentLines: [
            'describe("generated", function () {',
            '  it("passes", function () {})',
            '})',
          ],
        },
      ],
      cleanupPaths,
    },
  }
}
