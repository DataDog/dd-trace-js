# startup

Measures tracer startup overhead with and without a realistic dependency
load surface. The signal is `with-tracer-everything` − `control-everything`:
how much the tracer's loader hooks add when there's a representative
dependency graph to wrap. See `meta.json` for the variant set.

## The fixture

`everything-fixture/` is a self-contained sub-project with its own
`package.json`, `package-lock.json`, and `node_modules`. The bench loads
it through a single `require('./everything-fixture')`. Stability
properties:

- dd-trace's own dependency tree (top-level deps, vendoring, hoisting)
  does not affect it.
- A fixture dependency cutting a breaking release is pinned by the
  lockfile.
- The package list lives in exactly one place (the manifest), so the
  `require()` list cannot drift away from the install set.
- A missing module fails `npm ci` loudly before the benchmark runs.

The package set is curated for a realistic production Node.js
application — web frameworks, HTTP clients, database drivers, message
queues, loggers — biased toward modules that dd-trace instruments.

## Updating the fixture

```sh
cd benchmark/sirun/startup/everything-fixture
# edit package.json
npm install
git add package.json package-lock.json
```

Do not commit `node_modules/`; `runall.sh` re-installs via `npm ci`.

The bench runs across the Node majors listed in
`.gitlab/benchmarks.yml` (currently 20–26), so every pinned version
must:

1. Have an `engines.node` range that includes the matrix floor,
   including all transitive dependencies after `npm install` resolves.
2. Be loadable through CJS `require()`. ESM-only releases (recent `got`,
   `uuid`) break the fixture's `require(name)` walk; pin a CJS-era
   version (e.g. `got@11`, `uuid@9`) instead.

Some top-level packages still satisfy (1) and (2) themselves but pull
in transitive deps that bumped past the matrix floor. When that
happens, add an `overrides` entry pinning the offending transitive dep
to the last release that supports the floor; do not downgrade the
top-level package unless it has no other compatible release.
