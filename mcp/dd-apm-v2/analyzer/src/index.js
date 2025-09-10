#!/usr/bin/env node
'use strict'

/**
 * Simplified APM Package Analyzer v2
 *
 * Purpose: Static analysis of npm packages to identify instrumentation targets
 * Input: Package name
 * Output: Clean JSON with methods, exports, and metadata
 *
 * Design Principles:
 * - Single responsibility: analysis only
 * - Clear input/output contracts
 * - No code generation
 * - Human-readable results
 */

const fs = require('fs').promises
const path = require('path')
const { execSync } = require('child_process')
const { MCPClient } = require('../../shared/mcp-client')

class PackageAnalyzer {
  constructor () {
    this.tempDir = null
    this.mcpClient = new MCPClient()
    this.results = {
      package: null,
      category: null,
      exports: [],
      methods: [],
      dependencies: [],
      metadata: {}
    }
  }

  async analyze (packageName) {
    console.log(`🔍 Analyzing package: ${packageName}`)

    try {
      await this.mcpClient.connect()
      await this.setupTempDir(packageName)
      await this.extractPackageInfo()
      await this.analyzeExports()
      await this.categorizePackage()
      await this.cleanup()

      return this.results
    } catch (error) {
      console.error('❌ Analysis failed:', error.message)
      await this.cleanup()
      await this.mcpClient.disconnect()
      throw error
    } finally {
      await this.mcpClient.disconnect()
    }
  }

  async setupTempDir (packageName) {
    this.tempDir = path.join(process.cwd(), '.dd-analyze-temp')
    await this.mcpClient.mkdir(this.tempDir)

    console.log(`📦 Downloading ${packageName}...`)
    execSync(`npm pack ${packageName}`, { cwd: this.tempDir })

    const tarFile = await fs.readdir(this.tempDir)
      .then(files => files.find(f => f.endsWith('.tgz')))

    execSync(`tar -xzf ${tarFile}`, { cwd: this.tempDir })
    this.packageDir = path.join(this.tempDir, 'package')
  }

  async extractPackageInfo () {
    const pkgPath = path.join(this.packageDir, 'package.json')
    const pkgJson = JSON.parse(await this.mcpClient.readFile(pkgPath))

    this.results.package = {
      name: pkgJson.name,
      version: pkgJson.version,
      main: pkgJson.main || 'index.js',
      description: pkgJson.description,
      keywords: pkgJson.keywords || []
    }

    this.results.dependencies = Object.keys(pkgJson.dependencies || {})
  }

  async analyzeExports () {
    const mainFile = path.join(this.packageDir, this.results.package.main)

    try {
      const content = await this.mcpClient.readFile(mainFile)
      const analysis = await this.mcpClient.analyzeCode(content, mainFile)
      this.results.exports = analysis.exports
      this.results.methods = analysis.methods
    } catch (error) {
      console.log(`⚠️  Could not analyze main file: ${error.message}`)
    }
  }

  extractExports (content) {
    const exports = []

    // Simple regex patterns for common export patterns
    const patterns = [
      /module\.exports\s*=\s*(\w+)/g,
      /exports\.(\w+)\s*=/g,
      /export\s+(?:default\s+)?(?:class|function)\s+(\w+)/g,
      /export\s*{\s*([^}]+)\s*}/g
    ]

    patterns.forEach(pattern => {
      let match
      while ((match = pattern.exec(content)) !== null) {
        exports.push(match[1])
      }
    })

    return [...new Set(exports)]
  }

  extractMethods (content) {
    const methods = []

    // Look for function definitions and method calls
    const patterns = [
      /(\w+)\.prototype\.(\w+)\s*=/g,
      /(\w+)\.(\w+)\s*=\s*function/g,
      /async\s+(\w+)\s*\(/g,
      /function\s+(\w+)\s*\(/g,
      /(\w+)\s*:\s*function/g
    ]

    patterns.forEach(pattern => {
      let match
      while ((match = pattern.exec(content)) !== null) {
        const methodName = match[2] || match[1]
        if (methodName && !methodName.startsWith('_')) {
          methods.push(methodName)
        }
      }
    })

    return [...new Set(methods)]
  }

  async categorizePackage () {
    const { name, keywords, description } = this.results.package
    const deps = this.results.dependencies

    // Enhanced categorization logic - check messaging first to handle queue libraries
    if (this.matchesCategory(['bullmq', 'bull', 'queue', 'job', 'worker', 'kafka', 'amqp', 'mqtt', 'rabbitmq', 'pubsub'], name, keywords, description)) {
      this.results.category = 'messaging'
    } else if (this.matchesCategory(['mysql', 'postgres', 'mongo', 'clickhouse', 'sqlite', 'database'], name, keywords, description)) {
      this.results.category = 'database'
    } else if (this.matchesCategory(['redis', 'memcached', 'cache'], name, keywords, description)) {
      // Redis can be cache or messaging - check context
      if (this.matchesCategory(['queue', 'job', 'worker', 'stream'], name, keywords, description)) {
        this.results.category = 'messaging'
      } else {
        this.results.category = 'cache'
      }
    } else if (this.matchesCategory(['express', 'koa', 'fastify', 'hapi', 'server', 'http'], name, keywords, description)) {
      this.results.category = 'web'
    } else if (this.matchesCategory(['axios', 'fetch', 'request', 'client', 'http'], name, keywords, description)) {
      this.results.category = 'http-client'
    } else if (this.matchesCategory(['aws', 'azure', 'gcp', 'cloud'], name, keywords, description)) {
      this.results.category = 'cloud'
    } else {
      this.results.category = 'library'
    }
  }

  matchesCategory (patterns, name, keywords = [], description = '') {
    const text = `${name} ${keywords.join(' ')} ${description}`.toLowerCase()
    return patterns.some(pattern => text.includes(pattern))
  }

  async cleanup () {
    if (this.tempDir) {
      try {
        execSync(`rm -rf ${this.tempDir}`)
      } catch (error) {
        console.warn(`⚠️  Could not clean up temp directory: ${error.message}`)
      }
    }
  }
}

// CLI Interface
async function main () {
  const packageName = process.argv[2]
  const outputFile = process.argv[3] || `${packageName.replace(/[@\/]/g, '-')}-analysis.json`

  if (!packageName) {
    console.error('Usage: dd-analyze <package-name> [output-file]')
    process.exit(1)
  }

  try {
    const analyzer = new PackageAnalyzer()
    const results = await analyzer.analyze(packageName)

    await analyzer.mcpClient.writeFile(outputFile, JSON.stringify(results, null, 2))
    console.log(`✅ Analysis complete: ${outputFile}`)
  } catch (error) {
    console.error('❌ Analysis failed:', error.message)
    process.exit(1)
  }
}

if (require.main === module) {
  main()
}

module.exports = { PackageAnalyzer }
