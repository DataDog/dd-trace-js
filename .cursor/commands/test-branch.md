Run all tests relevant for the changes in the current branch.
Integration tests needs to run outside the sandbox.
Prefer running multiple unit tests at the same time using a glob, even if a few is unrelated to the changes in the current brach.
Integration tests takes a long time to run, so be careful about using a glob unless you actually want to run every integration test included in the glob.
If any of the tests fail, do not try to fix them, but ask me what I want to do.
