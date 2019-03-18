#include "EventLoop.hpp"

namespace datadog {
  // http://docs.libuv.org/en/v1.x/design.html#the-i-o-loop
  EventLoop::EventLoop() {
    uv_check_init(uv_default_loop(), &check_handle_);
    uv_prepare_init(uv_default_loop(), &prepare_handle_);
    uv_unref(reinterpret_cast<uv_handle_t*>(&check_handle_));
    uv_unref(reinterpret_cast<uv_handle_t*>(&prepare_handle_));

    check_handle_.data = (void*)this;
    prepare_handle_.data = (void*)this;

    check_time_ = uv_hrtime();
    prepare_time_ = uv_hrtime();
  }

  EventLoop::~EventLoop() {
    uv_check_stop(&check_handle_);
  }

  void EventLoop::check_cb (uv_check_t* handle) {
    EventLoop* self = (EventLoop*)handle->data;
    self->check_time_ = uv_hrtime();
  }

  void EventLoop::prepare_cb (uv_prepare_t* handle) {
    EventLoop* self = (EventLoop*)handle->data;

    if (self->check_time_ != 0) {
      self->histogram_.add(uv_hrtime() - self->check_time_);
      self->check_time_ = 0;
    }
  }

  void EventLoop::enable() {
    uv_check_start(&check_handle_, &EventLoop::check_cb);
    uv_prepare_start(&prepare_handle_, &EventLoop::prepare_cb);
  }

  void EventLoop::disable() {
    uv_check_stop(&check_handle_);
    uv_prepare_stop(&prepare_handle_);
    histogram_.reset();
  }

  void EventLoop::inject(Object carrier) {
    carrier.set("eventLoop", histogram_);
    histogram_.reset();
  }
}
