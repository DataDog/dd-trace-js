'use strict'

const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.join(__dirname, '..')
const bunVersion = require('../package.json').devDependencies.bun
const bunCommand = process.platform === 'win32' ? 'bun.exe' : 'bun'

// Source archives can run prepare before Bun is installed. A different global Bun can change lock resolution.
// Reuse the pinned binary when available; bootstrap it with npm only when neither PATH nor the local cache supplies it.
// The npm package's postinstall places the platform binary at bin/bun.exe, so Bun itself must remain trusted.
function getBunBinary () {
  const installedVersion = spawnSync(bunCommand, ['--version'], { encoding: 'utf8' })
  if (installedVersion.status === 0 && installedVersion.stdout.trim() === bunVersion) {
    return bunCommand
  }

  const bootstrapDirectory = path.join(repoRoot, 'node_modules', '.cache', `bun-${bunVersion}`)
  const bunBinary = path.join(bootstrapDirectory, 'node_modules', 'bun', 'bin', 'bun.exe')
  const bootstrappedVersion = spawnSync(bunBinary, ['--version'], { encoding: 'utf8' })
  if (bootstrappedVersion.status !== 0 || bootstrappedVersion.stdout.trim() !== bunVersion) {
    fs.rmSync(bootstrapDirectory, { recursive: true, force: true })
    fs.mkdirSync(bootstrapDirectory, { recursive: true })
    fs.writeFileSync(path.join(bootstrapDirectory, 'package.json'), JSON.stringify({
      private: true,
      allowScripts: {
        [`bun@${bunVersion}`]: true,
      },
    }))
    // Reuse the npm that invoked us so the bootstrap inherits its registry and proxy settings. Bun and Yarn set
    // `npm_execpath` too, but to their own executable rather than to a JavaScript entry point, and `node <binary>`
    // makes Node parse a 60 MB executable as CJS and exit on a bare `SyntaxError` before the version check below can
    // report anything useful. That path is reached whenever the bootstrapped binary is missing, which is what
    // `bun install --ignore-scripts` leaves behind.
    const npmExecPath = process.env.npm_execpath
    let npm = 'npm'
    const npmArguments = ['install']
    if (npmExecPath && /\.[cm]?js$/.test(npmExecPath)) {
      npm = process.execPath
      npmArguments.unshift(npmExecPath)
    } else if (process.platform === 'win32') {
      // Node cannot execute npm.cmd directly. npm's Windows shim keeps its JavaScript CLI beside it.
      let npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
      if (process.env.PATH) {
        for (const directory of process.env.PATH.split(path.delimiter)) {
          const candidate = path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js')
          if (fs.existsSync(path.join(directory, 'npm.cmd')) && fs.existsSync(candidate)) {
            npmCli = candidate
            break
          }
        }
      }
      npm = process.execPath
      npmArguments.unshift(npmCli)
    }
    npmArguments.push(
      '--prefix', bootstrapDirectory,
      '--no-save',
      '--package-lock=false',
      '--include=optional',
      '--ignore-scripts=false',
      '--no-audit',
      '--no-fund',
      `bun@${bunVersion}`
    )
    execFileSync(npm, npmArguments, {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'inherit'],
    })
  }

  const resolvedVersion = spawnSync(bunBinary, ['--version'], { encoding: 'utf8' })
  if (resolvedVersion.status !== 0 || resolvedVersion.stdout.trim() !== bunVersion) {
    throw new Error(`Could not install Bun ${bunVersion} inside ${repoRoot}`)
  }
  return bunBinary
}

if (require.main === module) {
  const binary = getBunBinary()
  if (process.argv.length > 2) {
    execFileSync(binary, [`--config=${path.join(repoRoot, 'bunfig.toml')}`, ...process.argv.slice(2)], {
      stdio: 'inherit',
    })
  } else {
    process.stdout.write(binary)
  }
}

module.exports = { getBunBinary }
