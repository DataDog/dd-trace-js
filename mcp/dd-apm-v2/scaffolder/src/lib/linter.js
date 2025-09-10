'use strict'

const { spawn } = require('child_process')
const path = require('path')

/**
 * Linting utilities for scaffolder output
 * Ensures all generated files pass ESLint checks
 */

class Linter {
  constructor (repoRoot) {
    this.repoRoot = repoRoot
  }

  /**
   * Run ESLint on generated files
   */
  async lintFiles (filePaths) {
    if (!filePaths.length) {
      console.log('✓ No files to lint')
      return { success: true, errors: [] }
    }

    console.log(`📋 Linting ${filePaths.length} generated files...`)

    try {
      const result = await this.runESLint(filePaths)

      if (result.success) {
        console.log('✓ All generated files pass linting')
        return result
      } else {
        console.log(`❌ Found ${result.errors.length} linting errors:`)
        result.errors.forEach(error => {
          console.log(`   ${error.file}:${error.line}:${error.column} - ${error.message}`)
        })
        return result
      }
    } catch (error) {
      console.error('❌ Linting failed:', error.message)
      return { success: false, errors: [{ message: error.message }] }
    }
  }

  /**
   * Run ESLint with --fix to automatically fix issues
   */
  async fixFiles (filePaths) {
    if (!filePaths.length) {
      return { success: true, fixed: 0 }
    }

    console.log(`🔧 Auto-fixing linting issues in ${filePaths.length} files...`)

    try {
      const result = await this.runESLint(filePaths, ['--fix'])
      console.log('✓ Auto-fix completed')
      return result
    } catch (error) {
      console.error('❌ Auto-fix failed:', error.message)
      return { success: false, errors: [{ message: error.message }] }
    }
  }

  /**
   * Run ESLint command
   */
  async runESLint (filePaths, extraArgs = []) {
    return new Promise((resolve, reject) => {
      const args = [
        '.',
        '--concurrency=auto',
        '--max-warnings=0',
        ...extraArgs,
        '--',
        ...filePaths
      ]

      const eslint = spawn('npx', ['eslint', ...args], {
        cwd: this.repoRoot,
        stdio: ['pipe', 'pipe', 'pipe']
      })

      let stdout = ''
      let stderr = ''

      eslint.stdout.on('data', (data) => {
        stdout += data.toString()
      })

      eslint.stderr.on('data', (data) => {
        stderr += data.toString()
      })

      eslint.on('close', (code) => {
        if (code === 0) {
          resolve({ success: true, errors: [] })
        } else {
          // Parse ESLint output to extract errors
          const errors = this.parseESLintOutput(stdout + stderr)
          resolve({ success: false, errors })
        }
      })

      eslint.on('error', (error) => {
        reject(error)
      })
    })
  }

  /**
   * Parse ESLint output to extract structured error information
   */
  parseESLintOutput (output) {
    const errors = []
    const lines = output.split('\n')

    for (const line of lines) {
      // Match ESLint error format: /path/file.js:line:col error message
      const match = line.match(/(.+?):(\d+):(\d+)\s+(error|warning)\s+(.+)/)
      if (match) {
        errors.push({
          file: path.relative(this.repoRoot, match[1]),
          line: parseInt(match[2]),
          column: parseInt(match[3]),
          severity: match[4],
          message: match[5].trim()
        })
      }
    }

    return errors
  }

  /**
   * Get list of JavaScript files that should be linted
   */
  getJavaScriptFiles (filePaths) {
    return filePaths.filter(filePath =>
      filePath.endsWith('.js') ||
      filePath.endsWith('.mjs') ||
      filePath.endsWith('.ts')
    )
  }
}

module.exports = { Linter }
