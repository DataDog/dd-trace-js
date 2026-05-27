'use strict'

const { addHook } = require('./helpers/instrument')

// NOTE — intentional deviation from the standard `getHooks()` pattern used
// by other orchestrion integrations (see e.g. `langchain.js`, which iterates
// `getHooks('<package>')` and calls `addHook` per entry).
//
// The orchestrion rewriter reads its instrumentation config independently of
// this hook file — it loads `rewriter/instrumentations/anthropic-ai-claude-agent-sdk.js`
// directly via the `_compile` matcher and rewrites `sdk.mjs` at module load
// time. So the AST transform fires correctly regardless of what `addHook` is
// passed here; the only job of this file is to register the load-time hook
// that opens the channel-bridge for orchestrion's published events.
//
// We register against the bare package name (no `file: 'sdk.mjs'`) because
// `sdk.mjs` is the package's `main` entry, so ritm reports the loaded module
// as `'@anthropic-ai/claude-agent-sdk'` (no file suffix). If we used
// `getHooks()` it would emit `{ file: 'sdk.mjs' }` from the config's
// `filePath`, which makes `register.js` compute a non-matching fullFilename
// and the `instrumentation:load` channel would never fire.
addHook({ name: '@anthropic-ai/claude-agent-sdk', versions: ['>=0.3.152'] }, exports => exports)
