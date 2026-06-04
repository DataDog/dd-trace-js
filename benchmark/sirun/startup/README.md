Measures tracer startup overhead: how much the loader hooks add when wrapping a
representative production dependency graph. `everything-fixture/` is a
self-contained sub-project (own `package.json`/`package-lock.json`/`node_modules`)
loaded via a single `require`, curated toward modules dd-trace instruments.

## Updating the fixture

```sh
cd benchmark/sirun/startup/everything-fixture
# edit package.json
npm install
git add package.json package-lock.json
```

Do not commit `node_modules/`; `runall.sh` re-installs via `npm ci`. The bench
runs across the Node majors in `.gitlab/benchmarks.yml`, so every pinned version
must have an `engines.node` range including the matrix floor (transitive deps
included) and be loadable through CJS `require` — pin a CJS-era release for
ESM-only packages (e.g. `got@11`, `uuid@9`), or add an `overrides` entry for a
transitive dep that bumped past the floor.
