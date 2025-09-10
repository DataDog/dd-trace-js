#!/usr/bin/env node

'use strict'

const { Command } = require('commander')
const VersionManager = require('../src/index')

const program = new Command()

program
  .name('dd-apm-version-manager')
  .description('Manage versions for dd-trace integrations')
  .version('1.0.0')

program
  .command('analyze')
  .description('Analyze a package across versions to detect breaking changes')
  .argument('<package-name>', 'The npm package name to analyze')
  .option('-o, --output <file>', 'Output file for analysis results', 'version-analysis.json')
  .option('--versions <versions>', 'Comma-separated list of versions to analyze (default: auto-detect)')
  .option('--max-versions <count>', 'Maximum number of versions to analyze per major', '3')
  .option('--verbose', 'Show detailed output')
  .action(async (packageName, options) => {
    try {
      const manager = new VersionManager({
        packageName,
        outputFile: options.output,
        versions: options.versions ? options.versions.split(',') : null,
        maxVersions: parseInt(options.maxVersions),
        verbose: options.verbose
      })

      const result = await manager.analyzeVersions()
      console.log(`✅ Version analysis completed: ${result.totalVersions} versions analyzed`)
      console.log(`📄 Results saved to: ${options.output}`)

      if (result.breakingChanges.length > 0) {
        console.log(`⚠️  Found ${result.breakingChanges.length} potential breaking changes`)
      }
    } catch (error) {
      console.error('Error analyzing versions:', error.message)
      if (options.verbose) {
        console.error(error.stack)
      }
      process.exit(1)
    }
  })

program
  .command('setup')
  .description('Set up version configurations for an integration')
  .argument('<package-name>', 'The npm package name')
  .option('-a, --analysis <file>', 'Version analysis file to use', 'version-analysis.json')
  .option('--strategy <strategy>', 'Version selection strategy', 'popular')
  .option('--verbose', 'Show detailed output')
  .action(async (packageName, options) => {
    try {
      const manager = new VersionManager({
        packageName,
        analysisFile: options.analysis,
        strategy: options.strategy,
        verbose: options.verbose
      })

      const result = await manager.setupVersions()
      console.log(`✅ Version setup completed for ${packageName}`)
      console.log(`📁 Created ${result.versionsCreated} version directories`)
    } catch (error) {
      console.error('Error setting up versions:', error.message)
      if (options.verbose) {
        console.error(error.stack)
      }
      process.exit(1)
    }
  })

program
  .command('update-code')
  .description('Update version-specific shimming and test code')
  .argument('<package-name>', 'The npm package name')
  .option('-a, --analysis <file>', 'Version analysis file to use', 'version-analysis.json')
  .option('--shimming-only', 'Only update shimming code')
  .option('--tests-only', 'Only update test code')
  .option('--verbose', 'Show detailed output')
  .action(async (packageName, options) => {
    try {
      const manager = new VersionManager({
        packageName,
        analysisFile: options.analysis,
        shimmingOnly: options.shimmingOnly,
        testsOnly: options.testsOnly,
        verbose: options.verbose
      })

      const result = await manager.updateVersionSpecificCode()
      console.log(`✅ Version-specific code updated for ${packageName}`)
      console.log(`🔧 Updated ${result.shimmingUpdates} shimming files`)
      console.log(`🧪 Updated ${result.testUpdates} test files`)
    } catch (error) {
      console.error('Error updating version-specific code:', error.message)
      if (options.verbose) {
        console.error(error.stack)
      }
      process.exit(1)
    }
  })

program
  .command('recommend')
  .description('Recommend versions to support based on popularity and usage')
  .argument('<package-name>', 'The npm package name')
  .option('--min-downloads <count>', 'Minimum weekly downloads to consider', '10000')
  .option('--max-versions <count>', 'Maximum versions to recommend per major', '3')
  .option('--include-latest', 'Always include latest version')
  .action(async (packageName, options) => {
    try {
      const manager = new VersionManager({
        packageName,
        minDownloads: parseInt(options.minDownloads),
        maxVersions: parseInt(options.maxVersions),
        includeLatest: options.includeLatest
      })

      const recommendations = await manager.recommendVersions()

      console.log(`\n📊 Version Recommendations for ${packageName}:`)
      console.log('='.repeat(50))

      for (const major of Object.keys(recommendations).sort()) {
        console.log(`\n📦 Major Version ${major}:`)
        for (const rec of recommendations[major]) {
          console.log(`  • ${rec.version} - ${rec.downloads.toLocaleString()} weekly downloads ${rec.reason}`)
        }
      }
    } catch (error) {
      console.error('Error generating recommendations:', error.message)
      process.exit(1)
    }
  })

program.parse()
