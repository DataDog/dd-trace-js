#include "MemoryUsage.hpp"

namespace datadog {
  MemoryUsage::MemoryUsage() {
    uv_check_init(uv_default_loop(), &check_handle_);
    uv_unref(reinterpret_cast<uv_handle_t*>(&check_handle_));

    check_handle_.data = (void*)this;
  }

  MemoryUsage::~MemoryUsage() {
    uv_check_stop(&check_handle_);
  }

  void MemoryUsage::check_cb (uv_check_t* handle) {
    MemoryUsage* self = (MemoryUsage*)handle->data;


    v8::Isolate *isolate = v8::Isolate::GetCurrent();
    // V8 memory usage
    v8::HeapStatistics v8_heap_stats;
    isolate->GetHeapStatistics(&v8_heap_stats);
    size_t rss;
    int err = uv_resident_set_memory(&rss);
    if (err) {
      rss = -1;
    }
    self->total_heap_size_ = v8_heap_stats.total_heap_size();
    self->used_heap_size_ = v8_heap_stats.used_heap_size();
    self->total_heap_size_executable_ = v8_heap_stats.total_heap_size_executable();
    self->total_physical_size_ = v8_heap_stats.total_physical_size();
    self->total_available_size_ = v8_heap_stats.total_available_size();
    self->heap_size_limit_ = v8_heap_stats.heap_size_limit();
    self->malloced_memory_ = v8_heap_stats.malloced_memory();
    self->peak_malloced_memory_ = v8_heap_stats.peak_malloced_memory();
    self->rss_ = rss;
  }

  void MemoryUsage::enable() {
    uv_check_start(&check_handle_, &MemoryUsage::check_cb);
  }

  void MemoryUsage::disable() {
    uv_check_stop(&check_handle_);
  }

  void MemoryUsage::inject(Object carrier) {
    Object memory_usage;
    memory_usage.set("heapTotal", total_heap_size_);
    memory_usage.set("heapUsed", used_heap_size_);
    memory_usage.set("rss", rss_);
    memory_usage.set("total_heap_size", total_heap_size_);
    memory_usage.set("total_heap_size_executable", total_heap_size_executable_);
    memory_usage.set("total_physical_size", total_physical_size_);
    memory_usage.set("total_available_size", total_available_size_);
    memory_usage.set("heap_size_limit", heap_size_limit_);
    memory_usage.set("malloced_memory", malloced_memory_);
    memory_usage.set("peak_malloced_memory", peak_malloced_memory_);
    carrier.set("memoryUsage", memory_usage);
  }
}
