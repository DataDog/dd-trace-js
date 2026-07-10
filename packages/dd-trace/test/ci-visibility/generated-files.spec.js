'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  cleanupGeneratedFiles,
  cleanupGeneratedRuntimeFiles,
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

  it('refuses generated file paths that escape through a symbolic-link directory', function () {
    if (process.platform === 'win32') this.skip()

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-generated-files-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-generated-files-outside-'))
    const linkedDirectory = path.join(root, 'linked')
    const filename = path.join(linkedDirectory, 'dd-test-optimization-validation.test.js')

    fs.symlinkSync(outside, linkedDirectory)

    try {
      assert.throws(() => writeGeneratedFiles(getFramework(root, filename)), {
        message: /outside physical project root|symbolic link/,
      })
      assert.strictEqual(fs.existsSync(path.join(outside, path.basename(filename))), false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('does not delete outside files after the project root is replaced by a symbolic link', function () {
    if (process.platform === 'win32') this.skip()

    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-generated-files-root-swap-'))
    const root = path.join(base, 'project')
    const originalRoot = path.join(base, 'original-project')
    const outside = path.join(base, 'outside')
    fs.mkdirSync(root)
    fs.mkdirSync(outside)
    const filename = path.join(root, 'dd-test-optimization-validation.test.js')
    const framework = getFramework(root, filename)

    try {
      writeGeneratedFiles(framework)
      fs.renameSync(root, originalRoot)
      fs.symlinkSync(outside, root)
      fs.writeFileSync(path.join(outside, path.basename(filename)), 'customer data\n')

      cleanupGeneratedFiles({ frameworks: [framework] })

      assert.strictEqual(fs.readFileSync(path.join(outside, path.basename(filename)), 'utf8'), 'customer data\n')
      assert.strictEqual(fs.existsSync(path.join(originalRoot, path.basename(filename))), true)
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  it('does not delete redirected files after a generated directory is replaced by a symbolic link', function () {
    if (process.platform === 'win32') this.skip()

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-generated-files-directory-swap-'))
    const generatedDirectory = path.join(root, 'generated')
    const originalDirectory = path.join(root, 'original-generated')
    const redirectedDirectory = path.join(root, 'redirected')
    fs.mkdirSync(redirectedDirectory)
    const filename = path.join(generatedDirectory, 'dd-test-optimization-validation.test.js')
    const framework = getFramework(root, filename)

    try {
      writeGeneratedFiles(framework)
      fs.renameSync(generatedDirectory, originalDirectory)
      fs.symlinkSync(redirectedDirectory, generatedDirectory)
      fs.writeFileSync(path.join(redirectedDirectory, path.basename(filename)), 'customer data\n')

      cleanupGeneratedFiles({ frameworks: [framework] })

      assert.strictEqual(
        fs.readFileSync(path.join(redirectedDirectory, path.basename(filename)), 'utf8'),
        'customer data\n'
      )
      assert.strictEqual(fs.existsSync(path.join(originalDirectory, path.basename(filename))), true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses hidden secret-like values and control characters in generated source', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-generated-files-'))
    const filename = path.join(root, 'dd-test-optimization-validation.test.js')

    try {
      const secretFramework = getFramework(root, filename)
      secretFramework.generatedTestStrategy.files[0].contentLines = ['API_KEY="do-not-execute" npm test']
      assert.throws(() => writeGeneratedFiles(secretFramework), /no secret-like values/)

      const controlFramework = getFramework(root, filename)
      controlFramework.generatedTestStrategy.files[0].contentLines = ['safe\u001b[2Jhidden']
      assert.throws(() => writeGeneratedFiles(controlFramework), /printable source line/)

      const formatControlFramework = getFramework(root, filename)
      formatControlFramework.generatedTestStrategy.files[0].contentLines = ['API_KEY\uFE0F="do-not-execute"']
      assert.throws(() => writeGeneratedFiles(formatControlFramework), /printable source line/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
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

  it('does not delete undeclared files found beneath a generated directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-generated-files-'))
    const generatedDirectory = path.join(root, '__dd_validation__')
    const generated = path.join(generatedDirectory, 'dd-test-optimization-validation.test.js')
    const state = path.join(generatedDirectory, '.dd-test-optimization-validation-atr-state')
    const unrelated = path.join(generatedDirectory, 'keep-me.txt')
    const framework = getFramework(root, generated, [generatedDirectory])

    try {
      fs.mkdirSync(generatedDirectory)
      fs.writeFileSync(state, 'already passed\n')
      fs.writeFileSync(unrelated, 'customer data\n')

      writeGeneratedFiles(framework)
      cleanupGeneratedRuntimeFiles(framework)

      assert.strictEqual(fs.readFileSync(state, 'utf8'), 'already passed\n')
      assert.strictEqual(fs.readFileSync(unrelated, 'utf8'), 'customer data\n')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses to delete a pre-existing declared runtime file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-generated-files-'))
    const generated = path.join(root, 'dd-test-optimization-validation.test.js')
    const state = path.join(root, '.dd-test-optimization-validation-state')
    const framework = getFramework(root, generated, [generated, state])
    fs.writeFileSync(state, 'customer data\n')

    try {
      assert.throws(() => writeGeneratedFiles(framework), /Refusing to delete pre-existing/)
      assert.strictEqual(fs.readFileSync(state, 'utf8'), 'customer data\n')
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
