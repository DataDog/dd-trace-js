'use strict'

const { spawn } = require('child_process')
const fs = require('fs-extra')

/**
 * Clean up common code formatting issues
 */
function cleanCodeFormatting (code) {
  return code
    .split('\n')
    .map(line => line
      .replace(/\s+$/, '') // Remove trailing spaces
      .replace(/=\s{2,}/g, ' = ') // Fix multiple spaces after =
      .replace(/\s{2,}(?![^\S\n]*$)/g, ' ') // Replace multiple spaces with single (preserve indentation)
    )
    .filter(line => {
      // Remove incomplete variable declarations like "server = "
      return !/^\s*\w+\s*=\s*$/.test(line)
    })
    .join('\n')
}

/**
 * Run ESLint on a file and return the results
 */
async function lintFile (filePath) {
  return new Promise((resolve) => {
    const eslint = spawn('npx', ['eslint', '--format', 'json', filePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: process.cwd()
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
      try {
        const results = stdout ? JSON.parse(stdout) : []
        resolve({
          success: code === 0,
          results,
          error: stderr
        })
      } catch (error) {
        resolve({
          success: false,
          results: [],
          error: error.message
        })
      }
    })
  })
}

/**
 * Fix common linting issues automatically
 */
async function autoFixFile (filePath) {
  return new Promise((resolve) => {
    const eslint = spawn('npx', ['eslint', '--fix', filePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: process.cwd()
    })

    let stderr = ''

    eslint.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    eslint.on('close', (code) => {
      resolve({
        success: code === 0,
        error: stderr
      })
    })
  })
}

/**
 * Lint and auto-fix a generated file
 */
async function lintGeneratedFile (filePath, fileType = 'javascript') {
  try {
    // First, apply our custom formatting cleanup
    if (await fs.pathExists(filePath)) {
      const content = await fs.readFile(filePath, 'utf8')
      const cleanedContent = cleanCodeFormatting(content)
      await fs.writeFile(filePath, cleanedContent)
    }

    // Then run ESLint auto-fix
    const fixResult = await autoFixFile(filePath)

    // Check final linting status
    const lintResult = await lintFile(filePath)

    if (lintResult.results.length > 0 && lintResult.results[0].messages.length > 0) {
      const errors = lintResult.results[0].messages.filter(m => m.severity === 2)
      const warnings = lintResult.results[0].messages.filter(m => m.severity === 1)

      console.log(`📝 Linted ${filePath}:`)
      if (errors.length > 0) {
        console.log(`  ❌ ${errors.length} error(s)`)
        errors.slice(0, 3).forEach(err => {
          console.log(`    Line ${err.line}: ${err.message}`)
        })
        if (errors.length > 3) {
          console.log(`    ... and ${errors.length - 3} more errors`)
        }
      }
      if (warnings.length > 0) {
        console.log(`  ⚠️  ${warnings.length} warning(s)`)
      }
    } else {
      console.log(`✅ Linted ${filePath}: No issues found`)
    }

    return {
      success: lintResult.results.length === 0 || lintResult.results[0].messages.length === 0,
      errors: lintResult.results.length > 0 ? lintResult.results[0].messages.filter(m => m.severity === 2) : [],
      warnings: lintResult.results.length > 0 ? lintResult.results[0].messages.filter(m => m.severity === 1) : []
    }
  } catch (error) {
    console.warn(`Failed to lint ${filePath}:`, error.message)
    return { success: false, errors: [], warnings: [] }
  }
}

module.exports = {
  cleanCodeFormatting,
  lintFile,
  autoFixFile,
  lintGeneratedFile
}
