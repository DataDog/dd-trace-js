#include "GarbageCollection.hpp"

namespace datadog {
  GarbageCollection::GarbageCollection() {
    pause_[v8::GCType::kGCTypeScavenge] = Histogram();
    pause_[v8::GCType::kGCTypeMarkSweepCompact] = Histogram();
    pause_[v8::GCType::kGCTypeIncrementalMarking] = Histogram();
    pause_[v8::GCType::kGCTypeProcessWeakCallbacks] = Histogram();
    pause_[v8::GCType::kGCTypeAll] = Histogram();
  }

  void GarbageCollection::before(v8::GCType type) {
    start_time_ = uv_hrtime();
  }

  void GarbageCollection::after(v8::GCType type) {
    uint64_t usage = uv_hrtime() - start_time_;

    pause_[type].add(usage);
    pause_[v8::GCType::kGCTypeAll].add(usage);
  }

  void GarbageCollection::inject(Object carrier) {
    Object value;

    value.set("scavenge", pause_[v8::GCType::kGCTypeScavenge]);
    value.set("mark_sweep_compact", pause_[v8::GCType::kGCTypeMarkSweepCompact]);
    value.set("incremental_marking", pause_[v8::GCType::kGCTypeIncrementalMarking]);
    value.set("process_weak_callbacks", pause_[v8::GCType::kGCTypeProcessWeakCallbacks]);
    value.set("all", pause_[v8::GCType::kGCTypeAll]);

    carrier.set("gc", value);

    pause_[v8::GCType::kGCTypeScavenge].reset();
    pause_[v8::GCType::kGCTypeMarkSweepCompact].reset();
    pause_[v8::GCType::kGCTypeIncrementalMarking].reset();
    pause_[v8::GCType::kGCTypeProcessWeakCallbacks].reset();
    pause_[v8::GCType::kGCTypeAll].reset();
  }
}
