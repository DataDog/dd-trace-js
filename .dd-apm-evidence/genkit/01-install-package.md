# Stage 01: install `genkit@1.21.0`

Date: 2026-07-13 UTC

## Result

- Requested package: `genkit@1.21.0`
- Exact resolved version: `1.21.0`
- Isolated analysis workspace: `/tmp/dd-apm-genkit-1.21.0`
- Installed package root: `/tmp/dd-apm-genkit-1.21.0/node_modules/genkit`
- CommonJS entry: `/tmp/dd-apm-genkit-1.21.0/node_modules/genkit/lib/index.js`
- Package manifest: `/tmp/dd-apm-genkit-1.21.0/node_modules/genkit/package.json`
- Package manifest SHA-256: `d87afcdbd764e5bee2c73e77b016a907d240ec270ba3ad95cf7baa7aef83af3a`
- Analysis workspace `package.json` SHA-256: `205e225edf4c4e1e26e0a66e44ce62a86eeb6a7926a6e47b3bd8e3318ad90260`
- Analysis workspace `yarn.lock` SHA-256: `6df30ed3593dd5afad3c24b766f823ed8ce6dd0480079b8a361c89563b25d22a`

The exact package remains installed at the path above for the method inventory and documentation stages. The
resolved manifest and entry-point information are also captured in `01-resolved-package.json`.

## Environment

```text
node --version
v22.23.1

npm --version
10.9.8

yarn --version
1.22.22
```

## Reproduction commands

Run from `/tmp` unless a command contains an explicit `cd`:

```sh
mkdir -p /tmp/dd-apm-genkit-1.21.0
cd /tmp/dd-apm-genkit-1.21.0
npm init --yes
yarn add --exact genkit@1.21.0
yarn install --frozen-lockfile
npm list genkit --depth=0
node -e "const fs=require('node:fs'); const path=require('node:path'); const entry=require.resolve('genkit'); const root=path.dirname(path.dirname(entry)); const manifestPath=path.join(root,'package.json'); const pkg=JSON.parse(fs.readFileSync(manifestPath,'utf8')); console.log(JSON.stringify({requested:'genkit@1.21.0',resolvedVersion:pkg.version,entry,packageJson:manifestPath,packageRoot:root,main:pkg.main,module:pkg.module,type:pkg.type,exports:pkg.exports}, null, 2))"
realpath node_modules/genkit
sha256sum package.json yarn.lock node_modules/genkit/package.json
find node_modules/genkit -maxdepth 2 -type f -printf '%P\\n' | sort | head -80
```

## Validation output

`npm list genkit --depth=0`:

```text
dd-apm-genkit-1.21.0@1.0.0 /tmp/dd-apm-genkit-1.21.0
└── genkit@1.21.0
```

The initial Yarn install completed successfully, saved a lockfile, installed 300 dependencies, and reported
`genkit@1.21.0` as the direct dependency. Its bounded phase/result transcript and warning summary are preserved in
`01-yarn-install-output.txt`.
The subsequent frozen-lockfile verification also completed successfully and reported the workspace up to date.

## Installation observations

Yarn reported peer-dependency warnings caused by transitive `@genkit-ai/firebase@1.39.0` and
`@genkit-ai/google-cloud@1.39.0`, both of which declare a `genkit@^1.39.0` peer. These warnings did not change the
requested top-level resolution: both Yarn and npm resolve the installed target as exactly `genkit@1.21.0`.

An initial attempt to resolve `genkit/package.json` through Node failed with `ERR_PACKAGE_PATH_NOT_EXPORTED` because
the package does not export that subpath. The corrected manifest lookup starts from `require.resolve('genkit')` and
walks to the installed package root; the resulting values are stored in `01-resolved-package.json`.
