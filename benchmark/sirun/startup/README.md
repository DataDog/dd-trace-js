# startup

Measures tracer startup overhead in four variants:

- `control` — no tracer, no extra dependencies. Establishes the floor cost of
  starting Node and exiting.
- `with-tracer` — `require('dd-trace').init()` only. Isolates tracer init cost
  in the absence of any user dependencies.
- `control-everything` — no tracer, but `require()`s the curated fixture
  (`everything-fixture/`). Establishes the floor cost of loading a realistic
  application's dependency surface.
- `with-tracer-everything` — both. The interesting one: tracer init cost in the
  presence of a representative dependency graph, where the loader hooks
  (RITM/IITM) fire across the modules dd-trace instruments.

The signal we want is `with-tracer-everything` − `control-everything`, i.e.
"how long does the tracer add when there's a realistic load surface to wrap?".

## The fixture

The hand-curated EVERYTHING list that used to live inline in `startup-test.js`
drifted as dd-trace's own dependency tree changed (vendored modules,
optional/native deps, hoisting layout). Each drift broke the benchmark on CI
without the bench logic itself changing.

`everything-fixture/` is a self-contained sub-project that owns its own
`package.json`, `package-lock.json`, and `node_modules`. The bench loads it
through a single `require('./everything-fixture')`. Stability properties:

- dd-trace adding or removing a top-level dependency has no effect.
- dd-trace vendoring or de-vendoring a module has no effect.
- A fixture dependency cutting a breaking release is pinned by the lockfile.
- The package list lives in exactly one place (the manifest), so the
  `require()` list cannot drift away from the install set.
- A genuinely missing module fails the install step (`npm ci`) loudly, before
  the benchmark runs.

The package set is curated to represent a realistic production Node.js
application — web frameworks, HTTP clients, database drivers, message queues,
loggers, and a few common utilities — biased toward modules that dd-trace
instruments (so the tracer's loader hooks have something to wrap and we
actually measure the behaviour the variant claims to measure).

## Updating the fixture

```sh
cd benchmark/sirun/startup/everything-fixture
# edit package.json
npm install   # refreshes package-lock.json
git add package.json package-lock.json
```

Do not commit `node_modules/`; CI re-installs it via `npm ci` on every run.

## Running locally

The benchmark needs the fixture's dependencies installed:

```sh
(cd benchmark/sirun/startup/everything-fixture && npm ci)
```

`runall.sh` does this automatically before running the suite.
