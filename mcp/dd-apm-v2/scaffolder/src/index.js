#!/usr/bin/env node
'use strict'

/**
 * Modular APM Integration Scaffolder v2
 *
 * Purpose: Generate clean file structure for integrations
 * Input: Analysis JSON + integration name
 * Output: File structure with stubs, no complex code generation
 *
 * Design Principles:
 * - Modular: Each file type has its own generator
 * - Simple: Template-based, minimal logic
 * - Clean: Well-formatted, linted output
 * - Extensible: Easy to add new file types
 */

const fs = require('fs').promises
const path = require('path')

// Import file generators
const { updatePluginRegistry } = require('./generators/plugin-registry')
const { createInstrumentationFile } = require('./generators/instrumentation-file')
const { createPluginPackage } = require('./generators/plugin-package')

// Import new comprehensive generators
const { updateDocumentationFiles } = require('./generators/documentation')
const { updateCIWorkflow } = require('./generators/ci-workflow')
const { updateHooksRegistry } = require('./generators/hooks-registry')

// Import utilities
const { Linter } = require('./lib/linter')
const { VersionManager } = require('./lib/version-manager')

class IntegrationScaffolder {
  constructor () {
    this.analysis = null
    this.integrationName = null
    this.packageName = null
    this.outputDir = null
    this.generatedFiles = []
    this.linter = null
    this.versionManager = null
  }

  async scaffold (analysisFile, integrationName) {
    console.log(`🏗️  Scaffolding integration: ${integrationName}`)

    try {
      await this.loadAnalysis(analysisFile)
      this.integrationName = integrationName
      this.packageName = this.analysis.package.name
      // Output to the project root (dd-trace-js directory)
      this.outputDir = process.cwd().includes('mcp/dd-apm-v2')
        ? process.cwd().replace(/\/mcp\/dd-apm-v2.*/, '')
        : process.cwd()

      this.linter = new Linter(this.outputDir)
      this.versionManager = new VersionManager({
        ddTraceRoot: this.outputDir,
        verbose: true
      })

      // Automatically add package to versions package.json
      await this.updateVersionsPackage()

      await this.generateFileStructure()
      await this.lintGeneratedFiles()
      console.log('✅ Integration scaffolded successfully')
    } catch (error) {
      console.error('❌ Scaffolding failed:', error.message)
      throw error
    }
  }

  async loadAnalysis (analysisFile) {
    const content = await fs.readFile(analysisFile, 'utf8')
    this.analysis = JSON.parse(content)

    if (!this.analysis.package || !this.analysis.category) {
      throw new Error('Invalid analysis file: missing package or category')
    }
  }

  async updateVersionsPackage () {
    try {
      console.log(`📦 Ensuring ${this.packageName} is in versions package.json...`)
      const version = await this.versionManager.ensurePackageInVersions(this.packageName)
      console.log(`✅ Package ${this.packageName}@${version} added to versions`)

      // Get version recommendations for testing strategy
      const recommendations = await this.versionManager.getVersionRecommendations(this.packageName)
      console.log('📊 Version testing recommendations:')
      Object.entries(recommendations).forEach(([major, versions]) => {
        console.log(`  Major ${major}: ${versions.join(', ')}`)
      })
    } catch (error) {
      console.warn(`⚠️  Could not update versions package.json: ${error.message}`)
      console.warn('You may need to manually add the package to ' +
        'packages/dd-trace/test/plugins/versions/package.json')
    }
  }

  async generateFileStructure () {
    try {
      // 1. Create instrumentation file
      console.log('📝 Creating instrumentation file...')
      const instrumentationFile = await createInstrumentationFile(this.outputDir, this.integrationName, this.packageName, this.analysis)
      this.generatedFiles.push(instrumentationFile)

      // 2. Create plugin package
      console.log('📝 Creating plugin package...')
      const pluginFiles = await createPluginPackage(this.outputDir, this.integrationName, this.packageName, this.analysis)
      this.generatedFiles.push(...this.getPluginFiles(pluginFiles))

      // 3. Update plugin registry
      console.log('📝 Updating plugin registry...')
      await updatePluginRegistry(this.outputDir, this.integrationName, this.packageName)

      // 4. Update hooks registry
      console.log('📝 Updating hooks registry...')
      await updateHooksRegistry(this.outputDir, this.integrationName)

      // 5. Update all documentation files
      console.log('📝 Updating documentation files...')
      await updateDocumentationFiles(this.outputDir, this.integrationName, this.packageName, this.analysis)

      // 6. Update CI workflow
      console.log('📝 Updating CI workflow...')
      await updateCIWorkflow(this.outputDir, this.integrationName, this.analysis.category)
    } catch (error) {
      console.error(`❌ File generation failed: ${error.message}`)
      throw error
    }
  }

  getPluginFiles (pluginDir) {
    // Return paths to the JS files we created
    const files = [
      path.join(pluginDir, 'src', 'index.js'),
      path.join(pluginDir, 'test', 'index.spec.js')
    ]

    // Add messaging-specific files if they exist
    if (this.analysis.category === 'messaging') {
      files.push(
        path.join(pluginDir, 'src', 'producer.js'),
        path.join(pluginDir, 'src', 'consumer.js')
      )
    }

    return files
  }

  async lintGeneratedFiles () {
    if (!this.generatedFiles.length) {
      console.log('📋 No JavaScript files to lint')
      return
    }

    // Filter to only JavaScript files
    const jsFiles = this.linter.getJavaScriptFiles(this.generatedFiles)

    if (!jsFiles.length) {
      console.log('📋 No JavaScript files to lint')
      return
    }

    // First try to auto-fix common issues
    await this.linter.fixFiles(jsFiles)

    // Then check for remaining issues
    const result = await this.linter.lintFiles(jsFiles)

    if (!result.success && result.errors.length > 0) {
      console.log('⚠️  Generated files have linting issues that need manual attention')
      // Don't fail the scaffolding, just warn
    }
  }

  async writeFiles (files) {
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(this.outputDir, filePath)
      const dir = path.dirname(fullPath)

      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(fullPath, content)
      console.log(`  ✓ ${filePath}`)
    }
  }
}

// CLI Interface
async function main () {
  const analysisFile = process.argv[2]
  const integrationName = process.argv[3]

  if (!analysisFile || !integrationName) {
    console.error('Usage: dd-scaffold <analysis.json> <integration-name>')
    console.error('')
    console.error('This will automatically:')
    console.error('  • Add the package to versions package.json with latest version')
    console.error('  • Generate integration files with proper structure')
    console.error('  • Provide version testing recommendations')
    process.exit(1)
  }

  try {
    const scaffolder = new IntegrationScaffolder()
    await scaffolder.scaffold(analysisFile, integrationName)
  } catch (error) {
    console.error('❌ Scaffolding failed:', error.message)
    process.exit(1)
  }
}

if (require.main === module) {
  main()
}

module.exports = { IntegrationScaffolder }
