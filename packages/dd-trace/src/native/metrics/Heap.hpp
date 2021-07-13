#pragma once

#include <uv.h>

#include "Collector.hpp"
#include "Object.hpp"

namespace datadog {
  class HeapSpace {
    public:
      std::string space_name;
      size_t space_size;
      size_t space_used_size;
      size_t space_available_size;
      size_t physical_space_size;
  };

  class Heap : public Collector {
    public:
      Heap();
      ~Heap();
      Heap(const Heap&) = delete;
      void operator=(const Heap&) = delete;

      void enable();
      void disable();
      void inject(Object carrier);
    protected:
      static void check_cb (uv_check_t* handle);
    private:
      uv_check_t check_handle_;
      std::vector<HeapSpace> spaces_;
  };
}
