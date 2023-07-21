# Contributing to dd-trace-js

Please reach out before starting work on any major code changes.
This will ensure we avoid duplicating work, or that your code can't be merged due to a rapidly changing
base. If you would like support for a module that is not listed, [contact support][1] to share a request.

[1]: https://docs.datadoghq.com/help

## Keep changes small and incremental

Changes should be incremental and understandable. As much as possible, large-scale efforts should be broken up into many PRs over time for better reviewability. If a feature would require more changes to be "complete" it's fine to land partial changes if they are not wired up to anything yet, so long as tests are included which at least prove those parts work in isolation.

There are great benefits to taking a measured and iterative approach to improvement. When working on code in fewer places there is far less risk of running into merge conflicts or incompatibilities with other systems. Keeping contributions small makes them easy to review which makes that much quicker to land. Additionally, keeping things small and iterative makes it easier for other teams to review and understand what the code does.

## Be descriptive!

Sometimes code can be self-documenting, but often it can't. That is especially true to someone reviewing code they haven't worked on. Be conscious of writing code in a self-describing way and leave comments anywhere that self-description fails. This goes a long way towards making even complex code coherent to one not already familiar with it.

Try to write code in a way the describes the intent when read. For example, verbs can be used for function and method names to communicate that they are used to do some specific action. In doing so it becomes clear when referenced by name elsewhere that it is a function and what the function is meant to do. If a function can not be described with a simple verb it's probably too complex or does too many things.

## Avoid large refactors

Large refactors should generally be avoided in favour of iterative approaches. For example, rather than rewriting how every plugin works, one might make a special-case plugin that works a bit different for their particular use-case. If several dozen files need to change to add a feature we've probably done something wrong.

Sometimes new patterns or new ideas emerge which would be a substantial improvement over the existing state. It can be tempting to want to go all-in on a new way to do something, but the code churn can be hard to manage. It's best to introduce such new things incrementally and advocate for their adoption gradually through the rest of the codebase. As old systems are gradually phased out, the infrastructure which supports them can be deleted or relegated to lazy-loading only if and when that specific part of the system needs to be used.

## Always consider backportability

To reduce delta between release lines and make it easier for us to support older versions we try as much as possible to backport every change we can. We should be diligent about keeping breaking changes to a minimum and ensuring we don't use language or runtime features which are too new. This way we can generally be confident that a change can be backported.

Currently we do not have CI to test PRs for mergeability to past release lines, but we intend to expand our CI to include that in the future. For the time being, it's recommended when developing locally to try to cherry-pick your changes onto the previous vN.x branches to see if the tests pass there too.

## Respect semantic versioning

This library follows the semantic versioning standard, but there are some subtleties left under-specified so this section is meant to clarify exactly how we interpret the meaning of semver. Additionally, it exists to communicate that we also use semver labels on all PRs to indicate which type of release the change should land in. Outside contributions should be evaluated and a semver label selected by the relevant team.

### semver-patch

If the change is a bug or security fix, it should be labelled as semver-patch. These changes should generally not alter existing behaviour in any way other than to correct the specific issue.

### semver-minor

Any addition of new functionality should be labelled as semver-minor and should not change any existing behaviour either in how any existing API works or in changing the contents or value of any existing data being reported except in purely additive cases where all existing data retains its prior state. Such changes may include new configuration options which when used will change behaviour, or may include the addition of new data being captured such as a new instrumentation, but should not impact the current operating design of any existing features.

### semver-major

In the event that some existing functionality _does_ need to change, as much as possible the non-breaking aspects of that change should be made in a semver-minor PR and the actually breaking aspects should be done via a follow-up PR with only the specific aspects which are breaking. For example, new functionality which would change existing behaviour could be added behind a flag and then that change could be made the default state of that flag in the next major release.
