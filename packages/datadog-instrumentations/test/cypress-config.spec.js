'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { format } = require('node:util')

const { afterEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()

describe('cypress config instrumentation', () => {
  const temporaryDirectories = []

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { force: true, recursive: true })
    }
  })

  /**
   * @param {string} code filesystem error code
   * @param {string} filePath affected path
   * @param {string} [syscall] failed system call
   * @returns {NodeJS.ErrnoException} filesystem error
   */
  function createFileError (code, filePath, syscall = 'open') {
    return Object.assign(new Error(`${code}: ${syscall} ${filePath}`), {
      code,
      path: filePath,
      syscall,
    })
  }

  /**
   * @returns {string} temporary Cypress project root
   */
  function createProjectRoot () {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-cypress-config-'))
    temporaryDirectories.push(projectRoot)
    return projectRoot
  }

  /**
   * @param {object} [fsStub] filesystem overrides
   * @param {() => string} [randomUUID] UUID generator
   * @returns {{ cypressConfig: object, warnings: string[] }} loaded instrumentation and warnings
   */
  function loadCypressConfig (fsStub, randomUUID) {
    const warnings = []
    let uuid = 0
    const stubs = {
      crypto: {
        randomUUID: randomUUID || (() => `uuid-${++uuid}`),
      },
      '../../dd-trace/src/log': {
        warn: (...args) => warnings.push(format(...args)),
      },
      './helpers/instrument': {
        channel: () => ({ hasSubscribers: false, publish: () => {} }),
      },
    }

    if (fsStub) stubs.fs = fsStub

    return {
      cypressConfig: proxyquire('../src/cypress-config', stubs),
      warnings,
    }
  }

  /**
   * @param {object} cypressConfig Cypress config instrumentation
   * @param {object} resolvedConfig resolved Cypress config
   * @returns {{ handlers: Record<string, Function>, result: object }} registered handlers and returned config
   */
  function injectSupportFile (cypressConfig, resolvedConfig) {
    const configFile = { e2e: {} }
    const handlers = {}
    cypressConfig.wrapConfig(configFile)

    const result = configFile.e2e.setupNodeEvents((event, handler) => {
      handlers[event] = handler
    }, resolvedConfig)

    return { handlers, result }
  }

  /**
   * @param {string} directory directory to inspect
   * @returns {string[]} generated Cypress files
   */
  function getGeneratedFiles (directory) {
    return fs.readdirSync(directory)
      .filter(file => file.startsWith('dd-cypress-support-') || file.startsWith('.dd-cypress-config-'))
  }

  /**
   * @param {string} code error code raised after a partial write
   * @param {(writeNumber: number) => boolean} [shouldFail] selects the write that fails
   * @returns {object} filesystem stub
   */
  function createPartialWriteFailure (code, shouldFail = () => true) {
    const pathsByDescriptor = new Map()
    let writeNumber = 0

    return {
      openSync (filePath, flags) {
        const descriptor = fs.openSync(filePath, flags)
        pathsByDescriptor.set(descriptor, filePath)
        return descriptor
      },
      writeFileSync (file, content, ...args) {
        if (typeof file === 'number' && pathsByDescriptor.has(file)) {
          writeNumber++
          if (!shouldFail(writeNumber)) return fs.writeFileSync(file, content, ...args)

          const filePath = pathsByDescriptor.get(file)
          fs.writeFileSync(file, 'partial')
          throw createFileError(code, filePath, 'write')
        }
        return fs.writeFileSync(file, content, ...args)
      },
      closeSync (descriptor) {
        pathsByDescriptor.delete(descriptor)
        return fs.closeSync(descriptor)
      },
    }
  }

  describe('support wrapper', () => {
    it('falls back to the project root when the support directory is not writable', async () => {
      const projectRoot = createProjectRoot()
      const supportDirectory = path.join(projectRoot, 'cypress', 'support')
      const supportFile = path.join(supportDirectory, 'e2e.js')
      fs.mkdirSync(supportDirectory, { recursive: true })
      fs.writeFileSync(supportFile, '// user support\n')

      const { cypressConfig, warnings } = loadCypressConfig({
        openSync (filePath, flags) {
          if (path.dirname(filePath) === supportDirectory) {
            throw createFileError('EACCES', filePath)
          }
          return fs.openSync(filePath, flags)
        },
      })
      const resolvedConfig = { projectRoot, supportFile }
      const { handlers } = injectSupportFile(cypressConfig, resolvedConfig)

      assert.strictEqual(path.dirname(resolvedConfig.supportFile), projectRoot)
      assert.deepStrictEqual(warnings, [])
      assert.strictEqual(getGeneratedFiles(projectRoot).length, 2)

      await handlers['after:run']({})
      assert.deepStrictEqual(getGeneratedFiles(projectRoot), [])
    })

    it('warns with every failed location when no directory is writable', () => {
      const projectRoot = createProjectRoot()
      const supportDirectory = path.join(projectRoot, 'cypress', 'support')
      const supportFile = path.join(supportDirectory, 'e2e.js')
      fs.mkdirSync(supportDirectory, { recursive: true })
      fs.writeFileSync(supportFile, '// user support\n')

      const { cypressConfig, warnings } = loadCypressConfig({
        openSync (filePath) {
          throw createFileError('EROFS', filePath)
        },
      })
      const resolvedConfig = { projectRoot, supportFile }
      injectSupportFile(cypressConfig, resolvedConfig)

      assert.strictEqual(resolvedConfig.supportFile, supportFile)
      assert.strictEqual(warnings.length, 1)
      assert.match(warnings[0], /could not create the Cypress support wrapper/)
      assert.strictEqual(warnings[0].match(/EROFS during open/g).length, 2)
      assert.match(warnings[0], new RegExp(supportDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      assert.match(warnings[0], new RegExp(projectRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    })

    it('warns when the original support file cannot be read', () => {
      const projectRoot = createProjectRoot()
      const supportFile = path.join(projectRoot, 'e2e.js')
      fs.writeFileSync(supportFile, '// user support\n')

      const { cypressConfig, warnings } = loadCypressConfig({
        readFileSync (filePath, ...args) {
          if (filePath === supportFile) throw createFileError('EACCES', filePath, 'read')
          return fs.readFileSync(filePath, ...args)
        },
      })
      const resolvedConfig = { projectRoot, supportFile }
      injectSupportFile(cypressConfig, resolvedConfig)

      assert.strictEqual(resolvedConfig.supportFile, supportFile)
      assert.strictEqual(warnings.length, 1)
      assert.match(warnings[0], /could not read the Cypress support file/)
      assert.match(warnings[0], /EACCES during read/)
    })

    it('removes partial support files when the filesystem runs out of space', () => {
      const projectRoot = createProjectRoot()
      const supportDirectory = path.join(projectRoot, 'cypress', 'support')
      const supportFile = path.join(supportDirectory, 'e2e.js')
      fs.mkdirSync(supportDirectory, { recursive: true })
      fs.writeFileSync(supportFile, '// user support\n')

      const { cypressConfig, warnings } = loadCypressConfig(createPartialWriteFailure('ENOSPC'))
      injectSupportFile(cypressConfig, { projectRoot, supportFile })

      assert.strictEqual(warnings.length, 1)
      assert.match(warnings[0], /ENOSPC during write/)
      assert.deepStrictEqual(getGeneratedFiles(supportDirectory), [])
      assert.deepStrictEqual(getGeneratedFiles(projectRoot), [])
    })

    it('removes the browser hooks when writing the support wrapper fails', () => {
      const projectRoot = createProjectRoot()
      const supportDirectory = path.join(projectRoot, 'cypress', 'support')
      const supportFile = path.join(supportDirectory, 'e2e.js')
      fs.mkdirSync(supportDirectory, { recursive: true })
      fs.writeFileSync(supportFile, '// user support\n')

      const failWrapperWrites = writeNumber => writeNumber % 2 === 0
      const { cypressConfig, warnings } = loadCypressConfig(
        createPartialWriteFailure('ENOSPC', failWrapperWrites)
      )
      injectSupportFile(cypressConfig, { projectRoot, supportFile })

      assert.strictEqual(warnings.length, 1)
      assert.strictEqual(warnings[0].match(/ENOSPC during write/g).length, 2)
      assert.deepStrictEqual(getGeneratedFiles(supportDirectory), [])
      assert.deepStrictEqual(getGeneratedFiles(projectRoot), [])
    })
  })

  describe('configuration wrapper', () => {
    it('falls back to the project root when the config directory is not writable', () => {
      const projectRoot = createProjectRoot()
      const configDirectory = path.join(projectRoot, 'config')
      const configFile = path.join(configDirectory, 'cypress.config.js')
      fs.mkdirSync(configDirectory)
      fs.writeFileSync(configFile, 'module.exports = {}\n')

      const { cypressConfig, warnings } = loadCypressConfig({
        openSync (filePath, flags) {
          if (path.dirname(filePath) === configDirectory) {
            throw createFileError('EACCES', filePath)
          }
          return fs.openSync(filePath, flags)
        },
      })
      const result = cypressConfig.wrapCliConfigFileOptions({
        configFile,
        project: projectRoot,
      })

      assert.strictEqual(path.dirname(result.options.configFile), projectRoot)
      assert.deepStrictEqual(warnings, [])
      assert.strictEqual(getGeneratedFiles(projectRoot).length, 1)

      result.cleanup()
      assert.deepStrictEqual(getGeneratedFiles(projectRoot), [])
    })

    it('warns with every failed location when no directory is writable', () => {
      const projectRoot = createProjectRoot()
      const configDirectory = path.join(projectRoot, 'config')
      const configFile = path.join(configDirectory, 'cypress.config.js')
      fs.mkdirSync(configDirectory)
      fs.writeFileSync(configFile, 'module.exports = {}\n')

      const { cypressConfig, warnings } = loadCypressConfig({
        openSync (filePath) {
          throw createFileError('EROFS', filePath)
        },
      })
      const options = { configFile, project: projectRoot }
      const result = cypressConfig.wrapCliConfigFileOptions(options)

      assert.strictEqual(result.options, options)
      assert.strictEqual(warnings.length, 1)
      assert.match(warnings[0], /could not create the Cypress configuration wrapper/)
      assert.strictEqual(warnings[0].match(/EROFS during open/g).length, 2)
      assert.match(warnings[0], new RegExp(configDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      assert.match(warnings[0], new RegExp(projectRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    })

    it('does not overwrite an existing configuration wrapper', () => {
      const projectRoot = createProjectRoot()
      const configFile = path.join(projectRoot, 'cypress.config.js')
      const existingWrapper = path.join(projectRoot, `.dd-cypress-config-${process.pid}-collision.cjs`)
      fs.writeFileSync(configFile, 'module.exports = {}\n')
      fs.writeFileSync(existingWrapper, 'existing content\n')

      const { cypressConfig, warnings } = loadCypressConfig(undefined, () => 'collision')
      const options = { configFile, project: projectRoot }
      const result = cypressConfig.wrapCliConfigFileOptions(options)

      assert.strictEqual(result.options, options)
      assert.strictEqual(fs.readFileSync(existingWrapper, 'utf8'), 'existing content\n')
      assert.strictEqual(warnings.length, 1)
      assert.match(warnings[0], /EEXIST during open/)
    })

    it('removes a partial configuration wrapper when the filesystem runs out of space', () => {
      const projectRoot = createProjectRoot()
      const configFile = path.join(projectRoot, 'cypress.config.js')
      fs.writeFileSync(configFile, 'module.exports = {}\n')

      const { cypressConfig, warnings } = loadCypressConfig(createPartialWriteFailure('ENOSPC'))
      const options = { configFile, project: projectRoot }
      const result = cypressConfig.wrapCliConfigFileOptions(options)

      assert.strictEqual(result.options, options)
      assert.strictEqual(warnings.length, 1)
      assert.match(warnings[0], /ENOSPC during write/)
      assert.deepStrictEqual(getGeneratedFiles(projectRoot), [])
    })
  })
})
