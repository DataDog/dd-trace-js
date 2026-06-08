#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const {
  analyzeIntakeArtifact,
  buildKnownTestsFromArtifact,
  renderAnalysisText,
} = require('./test-optimization-intake-analysis')

/**
 * Parses CLI arguments.
 *
 * @param {string[]} args command-line arguments
 * @returns {object} parsed options
 */
function parseArgs (args) {
  const options = {
    json: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '--json') {
      options.json = true
    } else if (arg === '--open') {
      options.open = true
    } else if (arg === '--out') {
      options.out = args[++i]
    } else if (arg.startsWith('--out=')) {
      options.out = arg.slice('--out='.length)
    } else if (arg === '--known-tests-out') {
      options.knownTestsOut = args[++i]
    } else if (arg.startsWith('--known-tests-out=')) {
      options.knownTestsOut = arg.slice('--known-tests-out='.length)
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (options.file) {
      options.unknown = arg
    } else {
      options.file = arg
    }
  }

  return options
}

/**
 * Returns CLI help text.
 *
 * @returns {string} help text
 */
function getHelpText () {
  return [
    'Usage: dd-trace-ci-analyze-intake <artifact.json> [--json] [--out <report.txt>] [--open]',
    '',
    'Applies fixed Test Optimization decision-tree rules to a fake intake artifact.',
    'With --open, tries common browser commands and then the OS opener for the generated HTML report.',
    'With --known-tests-out, writes known tests derived from captured test events.',
  ].join('\n')
}

/**
 * Reads and analyzes an artifact file.
 *
 * @param {string} file artifact path
 * @returns {object} analysis report
 */
function analyzeFile (file) {
  return analyzeIntakeArtifact(readArtifact(file))
}

/**
 * Reads an artifact file.
 *
 * @param {string} file artifact path
 * @returns {object} parsed artifact
 */
function readArtifact (file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'))
}

/**
 * Tries to open the HTML report with the operating system opener.
 *
 * @param {object} analysis analysis report
 * @returns {string} open attempt status
 */
function openHtmlReport (analysis) {
  const htmlPath = analysis.summary.artifacts.htmlPath

  if (!htmlPath) {
    return 'HTML report open attempt: skipped because the artifact does not include an HTML report path.'
  }

  const result = spawnOpenCommand(htmlPath)

  if (result.error) {
    return 'HTML report open attempt: unavailable; use the HTML report file URL above.'
  }

  if (result.status !== 0) {
    return 'HTML report open attempt: unavailable; use the HTML report file URL above.'
  }

  return `HTML report open attempt: opened with ${result.command}.`
}

/**
 * Runs the platform-specific file opener.
 *
 * @param {string} htmlPath HTML report path
 * @returns {object} spawn result
 */
function spawnOpenCommand (htmlPath) {
  const attempts = getOpenAttempts(htmlPath)
  let result
  const attempted = []

  for (const attempt of attempts) {
    attempted.push(attempt.display)
    result = spawnSync(attempt.command, attempt.args, { encoding: 'utf8' })

    if (!result.error && result.status === 0) {
      return {
        ...result,
        attempted,
        command: attempt.display,
      }
    }
  }

  return {
    ...result,
    attempted,
    command: attempted[attempted.length - 1],
  }
}

/**
 * Builds platform-specific HTML opener attempts.
 *
 * @param {string} htmlPath HTML report path
 * @returns {Array<object>} opener attempts
 */
function getOpenAttempts (htmlPath) {
  if (process.platform === 'darwin') {
    return [
      {
        args: ['-a', 'Google Chrome', htmlPath],
        command: 'open',
        display: `open -a 'Google Chrome' ${shellQuote(htmlPath)}`,
      },
      {
        args: ['-a', 'Chromium', htmlPath],
        command: 'open',
        display: `open -a Chromium ${shellQuote(htmlPath)}`,
      },
      {
        args: ['-a', 'Safari', htmlPath],
        command: 'open',
        display: `open -a Safari ${shellQuote(htmlPath)}`,
      },
      {
        args: [htmlPath],
        command: 'open',
        display: `open ${shellQuote(htmlPath)}`,
      },
    ]
  }

  if (process.platform === 'win32') {
    return [
      {
        args: ['/c', 'start', '', htmlPath],
        command: 'cmd',
        display: `start "" ${windowsQuote(htmlPath)}`,
      },
      {
        args: [htmlPath],
        command: 'explorer.exe',
        display: `explorer.exe ${windowsQuote(htmlPath)}`,
      },
    ]
  }

  return [
    {
      args: [htmlPath],
      command: 'google-chrome',
      display: `google-chrome ${shellQuote(htmlPath)}`,
    },
    {
      args: [htmlPath],
      command: 'chromium',
      display: `chromium ${shellQuote(htmlPath)}`,
    },
    {
      args: [htmlPath],
      command: 'chromium-browser',
      display: `chromium-browser ${shellQuote(htmlPath)}`,
    },
    {
      args: [htmlPath],
      command: 'firefox',
      display: `firefox ${shellQuote(htmlPath)}`,
    },
    {
      args: [htmlPath],
      command: 'xdg-open',
      display: `xdg-open ${shellQuote(htmlPath)}`,
    },
  ]
}

/**
 * Quotes a shell argument.
 *
 * @param {string} value argument value
 * @returns {string} quoted argument
 */
function shellQuote (value) {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`
}

/**
 * Quotes a Windows shell argument.
 *
 * @param {string} value argument value
 * @returns {string} quoted argument
 */
function windowsQuote (value) {
  return `"${value.replaceAll('"', String.raw`\"`)}"`
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2))

  if (options.help) {
    console.log(getHelpText())
  } else if (options.unknown) {
    console.error(`Unknown argument: ${options.unknown}`)
    console.error(getHelpText())
    process.exitCode = 1
  } else if (options.file) {
    try {
      const artifact = readArtifact(options.file)
      const analysis = analyzeIntakeArtifact(artifact)
      const openAttempt = options.open ? openHtmlReport(analysis) : undefined
      let output

      if (options.knownTestsOut) {
        const knownTests = buildKnownTestsFromArtifact(artifact)
        fs.writeFileSync(path.resolve(options.knownTestsOut), `${JSON.stringify(knownTests, null, 2)}\n`)
      }

      if (options.json) {
        output = JSON.stringify({
          ...analysis,
          openAttempt,
        }, null, 2)
      } else {
        output = renderAnalysisText(analysis)
        if (openAttempt) {
          output = `${output}\n\n${openAttempt}`
        }
      }

      if (options.out) {
        fs.writeFileSync(path.resolve(options.out), `${output}\n`)
      }

      console.log(output)
    } catch (error) {
      console.error(error.message)
      process.exitCode = 1
    }
  } else {
    console.error('Missing artifact path.')
    console.error(getHelpText())
    process.exitCode = 1
  }
}

module.exports = {
  analyzeFile,
  openHtmlReport,
  parseArgs,
  readArtifact,
}
