#pragma once

#include <stdint.h>
#include <uv.h>

#include "Collector.hpp"
#include "Histogram.hpp"

namespace datadog {
  class EventLoop : public Collector {
    public:
      EventLoop();
      ~EventLoop();

      void enable();
      void disable();
      void tick();
      void inject(Object carrier);
    protected:
      static void check_cb (uv_check_t* handle);
    private:
      uv_check_t check_handle_;
      uint64_t check_usage_;
      Histogram histogram_;

      uint64_t usage();
  };
}
