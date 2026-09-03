# test-codeowners

Measures `getCodeOwnersForFilename`, the per-test-file owner resolution Test
Optimization runs across a suite: a reversed walk of the parsed CODEOWNERS
entries testing each pattern's regex against the path until one matches. Entries
come from the real parser reading a committed snapshot of this repo's own
`.github/CODEOWNERS` (anchored / extension / `**` rules a big monorepo carries),
so the benchmark exercises a meaningful worst case rather than a synthesized
file. It runs lookups over a corpus of paths shaped like this repo's files
(matches at varying depths plus a full-scan miss); each pass uses a fresh cache
view so every lookup is a real regex scan.
