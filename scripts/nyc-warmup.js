'use strict'

// Force-require every source file matching nyc's include patterns so the
// require hook instruments and writes them to the on-disk cache. Subsequent
// test runs hit the cache instead of paying the per-file instrumentation cost
// during a `before all` hook (whose default 5s timeout is tight on a slow CI
// runner).

const fs = require('node:fs')
const path = require('node:path')

// Plugin and instrumentation sources frequently throw on require without their
// target module installed (and some packages emit warnings on load). The cache
// is populated before the throw, which is all we need — silence the noise.
process.stderr.write = () => true

const repoRoot = path.resolve(__dirname, '..')

function tryRequire (file) {
  try { require(file) } catch {}
}

function walk (dir) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))) tryRequire(full)
  }
}

// Mirror nyc.config.js `include`. `init.js` is intentionally omitted because
// requiring it would run the full dd-trace `init()` and start background work
// that delays process exit; the source files it would load are walked anyway.
walk(path.join(repoRoot, 'ext'))

for (const entry of fs.readdirSync(path.join(repoRoot, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const pkg = path.join(repoRoot, 'packages', entry.name)
  walk(path.join(pkg, 'src'))
  for (const f of fs.readdirSync(pkg)) {
    if (f.endsWith('.js') || f.endsWith('.mjs')) tryRequire(path.join(pkg, f))
  }
}

for (const f of ['index.js', 'register.js', 'version.js', 'initialize.mjs', 'loader-hook.mjs']) {
  tryRequire(path.join(repoRoot, f))
}
