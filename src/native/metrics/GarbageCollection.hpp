#pragma once

#include <map>
#include <string>
#include <stdint.h>
#include <uv.h>
#include <v8.h>

#include "Collector.hpp"
#include "Histogram.hpp"
#include "Object.hpp"

namespace datadog {
  class GarbageCollection : public Collector {
    public:
      GarbageCollection();

      void before(v8::GCType type);
      void after(v8::GCType type);
      void inject(Object carrier);
    private:
      std::map<v8::GCType, Histogram> pause_;
      std::map<unsigned char, std::string> types_ = {
        { 1, "scavenge" },
        { 2, "mark_sweep_compact" },
        { 3, "all" }, // Node 4
        { 4, "incremental_marking" },
        { 8, "process_weak_callbacks" },
        { 15, "all" }
      };
      uint64_t start_time_;
  };
}
