#include "EventLoop.hpp"

namespace datadog {
  // http://docs.libuv.org/en/v1.x/design.html#the-i-o-loop
  EventLoop::EventLoop() {
    uv_check_init(uv_default_loop(), &check_handle_);
    uv_unref(reinterpret_cast<uv_handle_t*>(&check_handle_));

    check_handle_.data = (void*)this;
    check_usage_ = usage();
  }

  void EventLoop::check_cb (uv_check_t* handle) {
    EventLoop* self = (EventLoop*)handle->data;
    self->tick();
  }

  void EventLoop::tick () {
    uint64_t usage = this->usage();

    histogram_.add(usage - check_usage_);
    check_usage_ = usage;
  }

  void EventLoop::enable() {
    uv_check_start(&check_handle_, &EventLoop::check_cb);
  }

  void EventLoop::disable() {
    uv_check_stop(&check_handle_);
    histogram_.reset();
  }

  uint64_t EventLoop::usage() {
    uv_rusage_t usage;
    uv_getrusage(&usage);

    return time_to_micro(usage.ru_utime) + time_to_micro(usage.ru_stime);
  }

  void EventLoop::inject(Object carrier) {
    carrier.set("eventLoop", histogram_);
    histogram_.reset();
  }
}
