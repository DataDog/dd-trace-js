# Design

Check whether the change has the right shape for this repository:

- Fit the existing architecture, module boundaries, and ownership of state.
- Reuse existing behavior instead of adding a second implementation that can drift.
- Challenge new public APIs, shared helpers, class hierarchies, and cross-module access.
- Check that invariants and failure behavior are explicit at the boundary that owns them.
- Prefer the smallest change at the highest correct layer.
- Distinguish a root-cause fix from a workaround that leaves the faulty model in place.

File a finding when the proposed shape creates coupling, drift, compatibility cost, or a harder extension path.
