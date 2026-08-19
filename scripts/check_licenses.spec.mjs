import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, it } from 'mocha'

const repositoryDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const checkerPath = join(repositoryDirectory, 'scripts', 'check_licenses.js')
const expectedDependencies = [
  '@scope/child',
  'dev-optional',
  'manually-vendored',
  'optional-package',
  'platform-only',
  'regular',
  'right-source',
  'root-package',
  'source-package',
  'transitive-source',
  'unversioned-target',
  'vendor-regular',
  'vendor-source',
]
const validYarnLock = `# yarn lockfile v1

"@scope/child@^1.0.0":
  version "1.0.0"

"aliased@npm:source-package@^2.0.0":
  version "2.0.0"

development@^1.0.0:
  version "1.0.0"

optional-package@^1.0.0:
  version "1.0.0"
  dependencies:
    "@scope/child" "^1.0.0"

"overridden@npm:right-source@2.0.0":
  version "2.0.0"

"overridden@npm:wrong-source@1.0.0":
  version "1.0.0"

platform-only@^1.0.0:
  version "1.0.0"

regular@^1.0.0:
  version "1.0.0"
  dependencies:
    "@scope/child" "^1.0.0"
    transitive-alias "npm:transitive-source@^1.0.0"
  optionalDependencies:
    platform-only "^1.0.0"

"transitive-alias@npm:transitive-source@^1.0.0":
  version "1.0.0"

"unversioned-alias@npm:unversioned-target":
  version "1.0.0"
`
const validPackageLock = {
  name: 'vendor',
  lockfileVersion: 3,
  packages: {
    '': {
      dependencies: {
        'vendor-alias': 'npm:vendor-source@1.0.0',
        'vendor-regular': '1.0.0',
      },
      devDependencies: {
        'vendor-development': '1.0.0',
      },
    },
    'node_modules/dev-optional': {
      devOptional: true,
      version: '1.0.0',
    },
    'node_modules/vendor-alias': {
      name: 'vendor-source',
      version: '1.0.0',
    },
    'node_modules/vendor-development': {
      dev: true,
      version: '1.0.0',
    },
    'node_modules/vendor-link': {
      link: true,
      resolved: 'packages/vendor-target',
    },
    'node_modules/vendor-peer': {
      peer: true,
      version: '1.0.0',
    },
    'node_modules/vendor-regular': {
      version: '1.0.0',
    },
  },
}
const validPackageJson = {
  name: 'root-package',
  dependencies: {
    aliased: 'npm:source-package@^2.0.0',
    overridden: 'npm:wrong-source@1.0.0',
    regular: '^1.0.0',
    'unversioned-alias': 'npm:unversioned-target',
  },
  devDependencies: {
    development: '^1.0.0',
  },
  optionalDependencies: {
    'optional-package': '^1.0.0',
    overridden: 'npm:right-source@2.0.0',
  },
}
const validBunPackageJson = {
  ...validPackageJson,
  dependencies: {
    ...validPackageJson.dependencies,
    'git-alias': 'github:example/source',
    internal: 'workspace:*',
    linked: 'link:../linked',
  },
}
const bunExpectedDependencies = [
  ...expectedDependencies,
  'git-source',
  'git-transitive',
  'link-transitive',
  'nested-only',
  'nested-version',
  'optional-peer',
  'peer-package',
  'top-level-only',
  'workspace-transitive',
]
const validBunLock = `{
  // Bun lockfiles are JSONC.
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "root-package",
      "dependencies": {
        "aliased": "npm:source-package@^2.0.0",
        "git-alias": "github:example/source",
        "internal": "workspace:*",
        "linked": "link:../linked",
        "overridden": "npm:wrong-source@1.0.0",
        "regular": "^1.0.0",
        "unversioned-alias": "npm:unversioned-target",
      },
      "devDependencies": {
        "development": "^1.0.0",
      },
      "optionalDependencies": {
        "optional-package": "^1.0.0",
        "overridden": "npm:right-source@2.0.0",
      },
    },
    "packages/internal": {
      "name": "internal",
      "version": "1.0.0",
      "dependencies": {
        "workspace-transitive": "^1.0.0",
      },
    },
  },
  "packages": {
    "@scope/child": ["@scope/child@1.0.0", "", {}, "sha512-child"],
    "aliased": ["source-package@2.0.0", "", {
      "dependencies": {
        "transitive-alias": "npm:transitive-source@^1.0.0",
      },
    }, "sha512-source"],
    "development": ["development@1.0.0", "", {}, "sha512-development"],
    "git-alias": ["git-source@github:example/source#commit", {
      "dependencies": {
        "git-transitive": "^1.0.0",
      },
    }, "example-source-commit"],
    "git-transitive": ["git-transitive@1.0.0", "", {}, "sha512-git-transitive"],
    "internal": ["internal@workspace:packages/internal"],
    "linked": ["linked@link:../linked", {
      "dependencies": {
        "link-transitive": "^1.0.0",
      },
    }],
    "link-transitive": ["link-transitive@1.0.0", "", {}, "sha512-link-transitive"],
    "nested-version": ["nested-version@1.0.0", "", {
      "dependencies": {
        "top-level-only": "^1.0.0",
      },
    }, "sha512-nested"],
    "optional-package": ["optional-package@1.0.0", "", {
      "dependencies": {
        "@scope/child": "^1.0.0",
        "nested-version": "^1.0.0",
      },
    }, "sha512-optional"],
    "optional-peer": ["optional-peer@1.0.0", "", {}, "sha512-optional-peer"],
    "overridden": ["right-source@2.0.0", "", {}, "sha512-overridden"],
    "peer-package": ["peer-package@1.0.0", "", {}, "sha512-peer"],
    "platform-only": ["platform-only@1.0.0", "", {}, "sha512-platform"],
    "regular": ["regular@1.0.0", "", {
      "dependencies": {
        "@scope/child": "^1.0.0",
        "nested-version": "^2.0.0",
      },
      "optionalDependencies": {
        "platform-only": "^1.0.0",
      },
      "peerDependencies": {
        "missing-optional-peer": "^1.0.0",
        "optional-peer": "^1.0.0",
        "peer-package": "^1.0.0",
      },
      "optionalPeers": [
        "missing-optional-peer",
        "optional-peer",
      ],
    }, "sha512-regular"],
    "regular/nested-version": ["nested-version@2.0.0", "", {
      "dependencies": {
        "nested-only": "^1.0.0",
      },
    }, "sha512-nested"],
    "nested-only": ["nested-only@1.0.0", "", {}, "sha512-nested-only"],
    "top-level-only": ["top-level-only@1.0.0", "", {}, "sha512-top-level-only"],
    "transitive-alias": ["transitive-source@1.0.0", "", {}, "sha512-transitive"],
    "unversioned-alias": ["unversioned-target@1.0.0", "", {}, "sha512-unversioned"],
    "workspace-transitive": ["workspace-transitive@1.0.0", "", {}, "sha512-workspace-transitive"],
  },
}`

/**
 * @typedef {object} FixtureOptions
 * @property {string} [bunLock]
 * @property {boolean} [includeVendoredDependencies]
 * @property {string[]} [licenses]
 * @property {object} [packageLock]
 * @property {object} [packageJson]
 * @property {string} [yarnLock]
 */

/**
 * @param {string[]} dependencies
 * @param {string} excluded
 */
function withoutDependency (dependencies, excluded) {
  const remaining = []
  for (const dependency of dependencies) {
    if (dependency !== excluded) remaining.push(dependency)
  }
  return remaining
}

describe('check_licenses', () => {
  /** @type {string} */
  let fixtureDirectory

  beforeEach(() => {
    fixtureDirectory = mkdtempSync(join(tmpdir(), 'dd-trace-license-check-'))
  })

  afterEach(() => {
    rmSync(fixtureDirectory, { force: true, recursive: true })
  })

  /**
   * @param {FixtureOptions} [options]
   */
  function writeFixture ({
    bunLock,
    includeVendoredDependencies = true,
    licenses = expectedDependencies,
    packageLock = validPackageLock,
    packageJson = validPackageJson,
    yarnLock = validYarnLock,
  } = {}) {
    const vendorDirectory = join(fixtureDirectory, 'vendor')

    mkdirSync(join(fixtureDirectory, '.github'), { recursive: true })
    mkdirSync(vendorDirectory, { recursive: true })
    if (includeVendoredDependencies) {
      writeFileSync(join(fixtureDirectory, '.github', 'vendored-dependencies.csv'), '"manually-vendored","MIT"\n')
    }
    const licenseRows = ['"Component","License"']
    for (const name of licenses) {
      licenseRows.push(`"${name}","MIT"`)
    }
    licenseRows.push('')
    writeFileSync(join(fixtureDirectory, 'LICENSE-3rdparty.csv'), licenseRows.join('\n'))
    writeFileSync(join(fixtureDirectory, 'package.json'), JSON.stringify(packageJson))
    writeFileSync(join(fixtureDirectory, 'yarn.lock'), yarnLock)
    if (bunLock !== undefined) writeFileSync(join(fixtureDirectory, 'bun.lock'), bunLock)
    writeFileSync(join(vendorDirectory, 'package-lock.json'), JSON.stringify(packageLock))
    writeFileSync(join(vendorDirectory, 'package.json'), JSON.stringify({
      dependencies: {
        'vendor-alias': 'npm:vendor-source@1.0.0',
        'vendor-regular': '1.0.0',
      },
    }))
  }

  function runChecker () {
    return spawnSync(process.execPath, [checkerPath], {
      cwd: fixtureDirectory,
      encoding: 'utf8',
    })
  }

  it('checks every production dependency from both lockfile formats', () => {
    writeFixture()

    const result = runChecker()

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('prefers bun.lock when both root lockfile formats exist', () => {
    writeFixture({
      bunLock: validBunLock,
      licenses: bunExpectedDependencies,
      packageJson: validBunPackageJson,
      yarnLock: 'not a yarn lockfile',
    })

    const result = runChecker()

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('accepts every supported bun lockfile version', () => {
    for (const version of [0, 2]) {
      writeFixture({
        bunLock: validBunLock.replace('"lockfileVersion": 1', `"lockfileVersion": ${version}`),
        licenses: bunExpectedDependencies,
        packageJson: validBunPackageJson,
      })

      const result = runChecker()

      assert.strictEqual(result.status, 0, result.stderr)
    }
  })

  it('reports missing and extraneous licenses', () => {
    writeFixture({
      licenses: [...withoutDependency(expectedDependencies, 'regular'), 'extraneous'],
    })

    const result = runChecker()

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /Missing 3rd-party license for regular\./)
    assert.match(result.stderr, /Extraneous 3rd-party license for extraneous\./)
  })

  it('checks repositories without manually vendored dependencies', () => {
    writeFixture({
      includeVendoredDependencies: false,
      licenses: withoutDependency(expectedDependencies, 'manually-vendored'),
    })

    const result = runChecker()

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('rejects an incomplete yarn lockfile', () => {
    writeFixture({
      yarnLock: validYarnLock.replace(`optional-package@^1.0.0:
  version "1.0.0"
  dependencies:
    "@scope/child" "^1.0.0"

`, ''),
    })

    const result = runChecker()

    assert.notStrictEqual(result.status, 0)
    assert.match(result.stderr, /optional-package@\^1\.0\.0/)
  })

  it('rejects a conflicted yarn lockfile', () => {
    writeFixture({
      yarnLock: `<<<<<<< HEAD
${validYarnLock}=======
${validYarnLock}>>>>>>> branch
`,
    })

    const result = runChecker()

    assert.notStrictEqual(result.status, 0)
    assert.match(result.stderr, /Cannot parse yarn\.lock: merge/)
  })

  it('rejects an invalid bun lockfile', () => {
    writeFixture({
      bunLock: validBunLock.replace('"packages": {', '"packages": ['),
      licenses: bunExpectedDependencies,
      packageJson: validBunPackageJson,
    })

    const result = runChecker()

    assert.notStrictEqual(result.status, 0)
    assert.match(result.stderr, /Cannot parse bun\.lock/)
  })

  it('rejects invalid bun lockfile metadata', () => {
    const invalidLocks = [
      ['null', /bun\.lock does not contain an object/],
      ['{"lockfileVersion":"1","packages":{},"workspaces":{"":{}}}', /Unsupported bun\.lock version: 1/],
      ['{"lockfileVersion":-1,"packages":{},"workspaces":{"":{}}}', /Unsupported bun\.lock version: -1/],
      ['{"lockfileVersion":3,"packages":{},"workspaces":{"":{}}}', /Unsupported bun\.lock version: 3/],
      ['{"lockfileVersion":1,"workspaces":{"":{}}}', /bun\.lock does not contain package metadata/],
      ['{"lockfileVersion":1,"packages":[],"workspaces":{"":{}}}', /bun\.lock does not contain package metadata/],
      ['{"lockfileVersion":1,"packages":{}}', /bun\.lock does not contain a root workspace/],
      ['{"lockfileVersion":1,"packages":{},"workspaces":[]}', /bun\.lock does not contain a root workspace/],
      ['{"lockfileVersion":1,"packages":{},"workspaces":{"other":{}}}', /bun\.lock does not contain a root workspace/],
    ]

    for (const [bunLock, expectedError] of invalidLocks) {
      writeFixture({ bunLock })

      const result = runChecker()

      assert.notStrictEqual(result.status, 0)
      assert.match(result.stderr, expectedError)
    }
  })

  it('rejects invalid bun package entries', () => {
    const invalidEntries = [
      [{ broken: {} }, /Invalid bun\.lock entry for broken/],
      [{ broken: ['broken'] }, /Invalid bun\.lock resolution for broken/],
      [{ broken: ['broken@workspace:packages/broken'] }, /Missing bun\.lock workspace for broken/],
      [{
        broken: ['broken@1.0.0', '', {
          peerDependencies: {
            peer: '^1.0.0',
          },
        }, 'sha512-broken'],
      }, /Missing bun\.lock entry for peer/],
    ]

    for (const [packages, expectedError] of invalidEntries) {
      writeFixture({
        bunLock: JSON.stringify({
          lockfileVersion: 1,
          packages,
          workspaces: {
            '': {
              dependencies: {
                broken: '1.0.0',
              },
            },
          },
        }),
        packageJson: {
          name: 'root-package',
          dependencies: {
            broken: '1.0.0',
          },
        },
      })

      const result = runChecker()

      assert.notStrictEqual(result.status, 0)
      assert.match(result.stderr, expectedError)
    }
  })

  it('rejects an incomplete bun lockfile', () => {
    writeFixture({
      bunLock: validBunLock.replace(
        '    "workspace-transitive": ["workspace-transitive@1.0.0", "", {}, "sha512-workspace-transitive"],\n',
        ''
      ),
      licenses: bunExpectedDependencies,
      packageJson: validBunPackageJson,
    })

    const result = runChecker()

    assert.notStrictEqual(result.status, 0)
    assert.match(result.stderr, /Missing bun\.lock entry for workspace-transitive/)
  })

  it('rejects a package lockfile without package metadata', () => {
    writeFixture({
      packageLock: {
        lockfileVersion: 1,
      },
    })

    const result = runChecker()

    assert.notStrictEqual(result.status, 0)
    assert.match(result.stderr, /package-lock\.json does not contain package metadata/)
  })

  it('rejects unnamed packages outside node_modules', () => {
    writeFixture({
      packageLock: {
        lockfileVersion: 3,
        packages: {
          '': {},
          'packages/unnamed': {
            version: '1.0.0',
          },
        },
      },
    })

    const result = runChecker()

    assert.notStrictEqual(result.status, 0)
    assert.match(result.stderr, /Cannot determine package name from packages\/unnamed/)
  })
})
