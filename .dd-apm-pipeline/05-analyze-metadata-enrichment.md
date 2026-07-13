# Step 5: analyze > metadata_enrichment

- Type: deterministic
- Objective: Enrich analysis targets with source file paths, module types, and ESM counterparts.

## Existing Workflow Guidance

Mostly deterministic, but has a fixer agent (opus) for missing file paths.
Locates the source file for each instrumentation target so the compile step knows
exactly which module to hook. For dd_trace_js, also validates that ESM counterparts
are found for packages that ship ES modules (dual CJS+ESM packages).

ESM validation (dd_trace_js only): if a package ships .mjs or /esm/ exports,
each target needs a file_paths entry with module_type='esm'. Missing entries trigger
the fixer agent, which searches the installed package tree for ESM variants.

For Java compiled libraries: enrichment runs best-effort without requiring source
file paths. Missing file paths won't cause failures — the compile step works with
class names alone.

Output artifact: enrichments.json (consumed by merge_layers)

## Instructions

Reproduce this workflow stage's stated outcome directly in the target repository. 
Inspect the current repository and prior pipeline results, follow repository standards, 
and preserve any result needed by later stages.

## Repair Prompt

Use this only if the stage result fails its required validation.

<!-- Workflow: create, Namespace: genkit, Step: metadata_enrichment -->

# Fix Enrichment Validation Errors

The enrichments for the `genkit` package have validation errors.
Your task is to fix these errors by locating the methods in the package source code
and updating the output with correct file paths and line numbers.

## Validation Errors

<derive from repository or prior step: validation_errors>

## Current Output

```json
<derive from repository or prior step: current_output>
```

## Search Strategy

1. **Check method inventory first** - methods may already be catalogued there
2. **Search package source files** using grep or search tools

## Package Location

The package is installed at: `.analysis/genkit/node_modules/genkit`

## Reference: All Methods

A complete list of all extracted methods from the package is available at:
`.analysis/genkit/static/all-methods.json`

Use this file to help locate methods - it may contain file paths and line numbers that
the automatic enrichment missed.

### JavaScript/Node.js File Patterns

- Look in `dist/`, `lib/`, `src/` directories
- Check `.js`, `.mjs`, `.cjs` extensions
- For `Class.prototype.method`, search for:
  - `class Class { method(` (ES6 class syntax)
  - `Class.prototype.method` (prototype assignment)

## Common Patterns

The package may use:
- ESM: `export class Foo { method() {} }`
- CommonJS: `Foo.prototype.method = function() {}`
- TypeScript compiled to JS in dist/ or lib/
- Re-exports from sub-packages

## ESM Counterpart Errors

If validation errors mention `file_paths has no ESM entry`, the package ships both
CJS and ESM builds and the target's `file_paths` list is missing the ESM location.

To fix:
1. Read `package.json` and check the `exports` map for `"import"` fields — those are the ESM entry points
2. Also check for a `"module"` field (legacy rollup convention)
3. Scan for `.mjs` files or `*.js` files inside `esm/` or `dist/esm/` directories
4. Search the ESM files for the method (class shorthand `method(`, `export function method`, etc.)
5. Add the found path to `file_paths` with `"module_type": "esm"`

**Important**: After updating `file_paths` in the enrichment output, also update the
corresponding entry in `data/agent.json` so downstream generation steps see the ESM paths.
The agent.json uses the same `file_paths` structure under `analysis.instrumentation_targets[]`.


## Sub-Package Handling

If a method is re-exported from a dependency:
1. Set `module_name` to the actual package where the function is defined
2. Use file paths relative to that package (not `../other-package/...`)

## Output Requirements

Update the enrichment data to fix the missing targets:
- Set `file_path` to the relative path within the package
- Set `line_number` to where the method is defined
- Set `kind` to `async` or `sync`
- Clear `missing_targets` when all targets are found
- Set `success` to `true` when complete


## Expected Output Format

Output must be valid JSON matching this format:

```typescript
{
  success?: boolean,
  error?: string | null,
  total_targets?: number,
  found_targets?: number,
  missing_targets?: string[],
  enrichments?: {
      targets?: ({
            target_name: string,
            file_path?: string,
            line_number?: number,
            module_name?: string,
            kind?: string | null,
            export_type?: string | null,
            file_paths?: ({
                    path: string,
                    line?: number,
                    module_type?: string,
            })[],
            confirmed_in_library?: boolean,
            language_specific?: Record<string, dict>,
      })[],
  },
}
```

**CRITICAL**: Return valid JSON at the top level. Do NOT wrap in `{"output": ...}` or other root level keys.

## Environment

Your current working directory is: `/Users/william.conti/Documents/dd-trace/dd-trace-js/apm_instrumentation_toolkit/.claude/worktrees/bits-genkit-llmobs-pipeline`

## Completion

Update `PROGRESS.md` with the result, changed files, commands run, and concrete evidence. 
Do not advance if this required stage is incomplete or its validation failed.
