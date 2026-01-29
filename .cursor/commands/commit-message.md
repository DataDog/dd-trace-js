Write a commit message for the staged changes.

Focus on the overall picture, a brief "what has changed", potentially followed by a "why" it was changed. Do not just blindly list every change. Only include specific changes if its relevant to understand the commit.

The subject line should be a maximum of 50 chars.
Each line of the body should be a maximum of 72 chars. Long URLs are allowed to exceed this.

Format it as a semantic commit message
- Format: `<type>(<scope>): <subject>` (`<scope>` is optional).

Semantic commit message types:
- feat: (new feature for the user, not a new feature for build script)
- fix: (bug fix for the user, not a fix to a build script)
- docs: (changes to the documentation)
- style: (formatting, missing semi colons, etc; no production code change)
- refactor: (refactoring production code, eg. renaming a variable)
- test: (adding missing tests, refactoring tests; no production code change)
- chore: (updating grunt tasks etc; no production code change)
