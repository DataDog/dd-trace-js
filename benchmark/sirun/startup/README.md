This is a simple startup test. It tests with an without the tracer, and with
and without requiring every dependency and devDependency in the package.json,
for a total of four variants.

While it's unrealistic to load all the tracer's devDependencies, the intention
is to simulate loading a lot of dependencies for an application, and have them
either be intercepted by our loader hooks, or not.
