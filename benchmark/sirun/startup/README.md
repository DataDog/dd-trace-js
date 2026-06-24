Measures tracer startup overhead: how much the loader hooks add when wrapping a
representative production dependency graph. `everything-fixture/` is a
self-contained sub-project (own `package.json`/`package-lock.json`/`node_modules`)
curated toward modules dd-trace instruments. Both fixture entries read the same
`dependencies`, so updating `package.json` covers both:

- `index.js` loads them with CommonJS `require`, exercising require-in-the-middle.
- `index.mjs` loads them with ESM `import`; the `with-tracer-everything-esm`
  variant registers the iitm ESM loader via `--import ../../../register.js`, so
  this is the variant that measures the synchronous-vs-asynchronous loader cost.

## Updating the fixture

```sh
cd benchmark/sirun/startup/everything-fixture
# edit package.json
npm install
git add package.json package-lock.json
```

Do not commit `node_modules/`; `runall.sh` re-installs via `npm ci`. The bench
runs across the Node majors in `.gitlab/benchmarks/gitlab-ci.yml`, so every pinned version
must have an `engines.node` range including the matrix floor (transitive deps
included) and be loadable through CJS `require` — pin a CJS-era release for
ESM-only packages (e.g. `got@11`, `uuid@9`), or add an `overrides` entry for a
transitive dep that bumped past the floor.
