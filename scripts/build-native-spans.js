'use strict'

// Builds the native-spans PoC crate and drops the loadable addon next to it.
//
// No `@napi-rs/cli`: that tooling exists for cross-compilation, which a
// build-from-source PoC does not need. `cargo build --release`, then rename the
// platform-specific shared library to `.node` so a plain `require()` finds it.

const { execFileSync } = require('node:child_process')
const { copyFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')

const CRATE_DIR = join(__dirname, '..', 'packages', 'dd-trace', 'src', 'native-spans', 'native')
const ADDON_PATH = join(CRATE_DIR, 'native_spans.node')

const LIBRARY_NAMES = {
  darwin: 'libnative_spans.dylib',
  linux: 'libnative_spans.so',
  win32: 'native_spans.dll',
}

const libraryName = LIBRARY_NAMES[process.platform]
if (libraryName === undefined) {
  throw new Error(`native-spans: unsupported platform ${process.platform}`)
}

execFileSync('cargo', ['build', '--release'], { cwd: CRATE_DIR, stdio: 'inherit' })

const builtPath = join(CRATE_DIR, 'target', 'release', libraryName)
if (!existsSync(builtPath)) {
  throw new Error(`native-spans: cargo reported success but ${builtPath} is missing`)
}

copyFileSync(builtPath, ADDON_PATH)
process.stdout.write(`native-spans: wrote ${ADDON_PATH}\n`)
