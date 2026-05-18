# ESM Support in Instrumentations

## Module Types

| Type | package.json | Hook Registration |
|------|--------------|-------------------|
| CommonJS only | No `"type"` field | `'pkg': () => require('../pkg')` |
| ESM only | `"type": "module"` | `'pkg': { esmFirst: true, fn: () => require('../pkg') }` |
| Dual (both) | Has `"exports"` with import/require | `'pkg': { esmFirst: true, fn: () => require('../pkg') }` |

## Detecting Package Type

### Check package.json
```json
{
  "type": "module",
  "exports": {
    ".": {
      "import": "./dist/esm/index.js",
      "require": "./dist/cjs/index.js"
    }
  }
}
```

### Check file structure
```
node_modules/pkg/
├── index.js          # CJS entry
├── index.mjs         # ESM entry
├── dist/
│   ├── cjs/          # CJS build
│   └── esm/          # ESM build
```

## The esmFirst Flag

When `esmFirst: true` is set:
1. dd-trace's ESM loader hook (`loader-hook.mjs`) intercepts imports
2. Instrumentation runs BEFORE the ESM module executes
3. Allows proper wrapping of ESM exports

```javascript
// hooks.js
module.exports = {
  'openai': { esmFirst: true, fn: () => require('../openai') },
  '@anthropic-ai/sdk': { esmFirst: true, fn: () => require('../anthropic') },
  'hono': { esmFirst: true, fn: () => require('../hono') },
}
```

## Handling Dual Packages

Dual packages may export differently:

```javascript
// CJS: module.exports = { Client }
// ESM: export { Client } or export default { Client }

addHook({ name: 'dual-pkg' }, (moduleExports) => {
  const Client = moduleExports.Client
    || moduleExports.default?.Client
    || moduleExports.default

  if (Client?.prototype) {
    shimmer.wrap(Client.prototype, 'method', ...)
  }

  return moduleExports
})
```

## Different CJS/ESM Build Paths

**Problem**: ESM and CJS builds may have different file paths but the same classes.

```
dual-pkg/
├── dist/cjs/client.js    # CJS build
└── dist/esm/client.js    # ESM build
```

**Solution for orchestrion**: Add separate entries for each file path:

```javascript
module.exports = [
  {
    module: { name: 'dual-pkg', filePath: 'dist/cjs/client.js', versionRange: '>=1.0.0' },
    functionQuery: { methodName: 'query', className: 'Client', kind: 'Async' },
    channelName: 'Client_query'
  },
  {
    module: { name: 'dual-pkg', filePath: 'dist/esm/client.js', versionRange: '>=1.0.0' },
    functionQuery: { methodName: 'query', className: 'Client', kind: 'Async' },
    channelName: 'Client_query'  // Same channelName — same plugin handles both
  }
]
```

**Solution for shimmer**: Instrument at a common point, or handle both:

```javascript
addHook({ name: 'dual-pkg', file: 'dist/cjs/client.js' }, patchClient)
addHook({ name: 'dual-pkg', file: 'dist/esm/client.js' }, patchClient)
```

## Common ESM Issues

### Missing esmFirst
**Symptom**: CJS tests pass, ESM tests show no spans
**Fix**: Add `esmFirst: true` to hooks.js entry

### Different Class Locations
**Symptom**: Works in one module system, not the other
**Fix**: Check where class is defined in both builds, add entries for each

### Re-exports
ESM often re-exports from submodules:
```javascript
// ESM index.mjs
export { Client } from './client.js'
```
Instrument at source (`client.js`) not just entry point.
