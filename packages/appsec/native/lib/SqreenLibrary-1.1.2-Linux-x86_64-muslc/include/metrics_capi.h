#ifndef METRICS_CAPI_H
#define METRICS_CAPI_H

#include <stdlib.h>
#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#ifndef METRICS_CAPI_IMPL
typedef struct perf2_coll_t perf2_coll_t;
typedef struct perf2_req_t perf2_req_t;
typedef struct perf2_argb_t perf2_argb_t;
#endif

/**********************************
 *  Collection related functions  *
 **********************************/

typedef struct perf2_data_t {
    const char *data;
    size_t len;
    void *reserved;
} perf2_data_t;

perf2_coll_t *perf2_coll_new(void);
void perf2_coll_free(perf2_coll_t *coll);
size_t perf2_coll_mem_size(const perf2_coll_t *coll);

/// Adds a request to a collection and clears the request,
/// which becomes empty and reusable.
void perf2_coll_add_and_clear(perf2_coll_t *coll, perf2_req_t *req);

/// Serializes the collection into a msgpack datastream and
/// clears the collection, which becomes empty and reusable.
/// @return an object that must be destroyed with perf2_data_destroy
perf2_data_t perf2_coll_flush(perf2_coll_t *coll);

/// Destroy the object returned by perf2_coll_flush
void perf2_data_destroy(perf2_data_t data);

/*********************************
 *   Request related functions   *
 *********************************/

perf2_req_t *perf2_req_new();
void perf2_req_free(perf2_req_t *req);
size_t perf2_req_mem_size(const perf2_req_t *req);

void perf2_req_set_route(perf2_req_t *req, const char *route, size_t route_len);
void perf2_req_set_overtime_cb(perf2_req_t *req, const char *cb, size_t cb_len);
void perf2_req_add_measurement(perf2_req_t *req,
                               const char *callback,
                               size_t callback_len,
                               double duration,
                               bool passed_precond);
void perf2_req_add_skipped_cb(perf2_req_t *req,
                              const char *callback,
                              size_t callback_len);
void perf2_req_add_slow_call(perf2_req_t *req,
                             const char *callback,
                             size_t callback_len,
                             double duration,
                             bool passed_precond,
                             perf2_argb_t **arg_builders,
                             uint8_t arg_builders_len);


/*********************************
 * ArgBuilder related functions  *
 *********************************/

perf2_argb_t *perf2_argb_new();
void perf2_argb_free(perf2_argb_t *argb);

void perf2_argb_start_array(perf2_argb_t *argb, size_t num_elements);
void perf2_argb_start_map(perf2_argb_t *argb, size_t num_pairs);
void perf2_argb_add_string(perf2_argb_t *argb, const char *str, size_t len);
void perf2_argb_add_null(perf2_argb_t *argb);
void perf2_argb_add_bool(perf2_argb_t *argb, bool value);
void perf2_argb_add_int32(perf2_argb_t *argb, int32_t value);
void perf2_argb_add_int64(perf2_argb_t *argb, int64_t value);
void perf2_argb_add_double(perf2_argb_t *argb, double value);

#ifdef __cplusplus
}
#endif

#endif
