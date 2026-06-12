# test-codeowners

Measures `getCodeOwnersForFilename`, the per-test-file owner resolution test
optimization runs across a suite: a reversed walk of the parsed CODEOWNERS
entries testing each pattern's regex against the path. Entries come from the real
parser over a generated fixture; each pass uses a fresh cache view so every
lookup is a real regex scan. Variants cover a small file, a large one, and a
wildcard-heavy one.
