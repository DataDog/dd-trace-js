'use strict'

const webpackPkg = require('webpack/package.json')

// webpack 5.107.0 introduced `experiments.typescript` (opt-in), and 5.109.0 defaults it to
// "auto". On Node.js >= 22.6 (where `module.stripTypeScriptTypes` exists), "auto" turns the
// experiment on and sets `resolve.tsconfig = true`, making enhanced-resolve walk up to each
// resolved package's own tsconfig.json. Some published packages (e.g. `side-channel`) ship a
// tsconfig.json that `extends` a devDependency-only config package (`@ljharb/tsconfig`) that
// isn't installed, so resolution fails with a "Module not found" error unrelated to
// TypeScript. Explicitly disable the experiment where the option exists; older webpack
// versions don't recognize the key at all, so it must not be set for those.
const [major, minor] = webpackPkg.version.split('.').map(Number)
const supportsTypescriptExperiment = major > 5 || (major === 5 && minor >= 107)

module.exports = supportsTypescriptExperiment ? { typescript: false } : undefined
