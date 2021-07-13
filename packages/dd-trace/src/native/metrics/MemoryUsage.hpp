#pragma once

#include <stdint.h>
#include <uv.h>

#include "Collector.hpp"
#include "Histogram.hpp"

namespace datadog {
  class MemoryUsage : public Collector {
    public:
      MemoryUsage();
      ~MemoryUsage();
      MemoryUsage(const MemoryUsage&) = delete;
      void operator=(const MemoryUsage&) = delete;

      void enable();
      void disable();
      void inject(Object carrier);
    protected:
      static void check_cb (uv_check_t* handle);
    private:
      uv_check_t check_handle_;
      size_t total_heap_size_;
      size_t used_heap_size_;
      size_t total_heap_size_executable_;
      size_t total_physical_size_;
      size_t total_available_size_;
      size_t heap_size_limit_;
      size_t malloced_memory_;
      size_t peak_malloced_memory_;
      size_t rss_;
  };
}
