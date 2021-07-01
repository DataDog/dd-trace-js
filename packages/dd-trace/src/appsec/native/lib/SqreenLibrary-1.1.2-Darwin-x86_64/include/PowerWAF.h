//
//  PowerWAF
//  Copyright © 2020 Sqreen. All rights reserved.
//

#ifndef pw_h
#define pw_h

#ifdef __cplusplus
extern "C"
{
#endif

#include <stdbool.h>
#include <stdint.h>

#define PW_MAX_STRING_LENGTH 4096
#define PW_MAX_MAP_DEPTH 20
#define PW_MAX_ARRAY_LENGTH 256
#define PW_RUN_TIMEOUT 5000

	typedef enum
	{
		PWI_INVALID         = 0,
		PWI_SIGNED_NUMBER   = 1 << 0, // `value` shall be decoded as a int64_t (or int32_t on 32bits platforms)
		PWI_UNSIGNED_NUMBER = 1 << 1, // `value` shall be decoded as a uint64_t (or uint32_t on 32bits platforms)
		PWI_STRING          = 1 << 2, // `value` shall be decoded as a UTF-8 string of length `nbEntries`
		PWI_ARRAY           = 1 << 3, // `value` shall be decoded as an array of PWArgs of length `nbEntries`, each item having no `parameterName`
		PWI_MAP             = 1 << 4, // `value` shall be decoded as an array of PWArgs of length `nbEntries`, each item having a `parameterName`
	} PW_INPUT_TYPE;

	typedef void* PWHandle;
	typedef void* PWAddContext;
	typedef struct _PWArgs PWArgs;

	struct _PWArgs
	{
		const char* parameterName;
		uint64_t parameterNameLength;
		union
		{
			const char* stringValue;
			uint64_t uintValue;
			int64_t intValue;
			const PWArgs* array;
			const void* rawHandle;
		};
		uint64_t nbEntries;
		PW_INPUT_TYPE type;
	};

	typedef enum
	{
		PWD_PARSING_JSON = 0,
		PWD_PARSING_RULE,
		PWD_PARSING_RULE_FILTER,
		PWD_OPERATOR_VALUE,
		PWD_DUPLICATE_RULE,
		PWD_PARSING_FLOW,
		PWD_PARSING_FLOW_STEP,
		PWD_MEANINGLESS_STEP,
		PWD_DUPLICATE_FLOW,
		PWD_DUPLICATE_FLOW_STEP,
		PWD_STEP_HAS_INVALID_RULE
	} PW_DIAG_CODE;

	typedef enum
	{
		PW_ERR_INTERNAL     = -6,
		PW_ERR_TIMEOUT      = -5,
		PW_ERR_INVALID_CALL = -4,
		PW_ERR_INVALID_RULE = -3,
		PW_ERR_INVALID_FLOW = -2,
		PW_ERR_NORULE       = -1,
		PW_GOOD             = 0,
		PW_MONITOR          = 1,
		PW_BLOCK            = 2
	} PW_RET_CODE;

	typedef enum
	{
		PWL_TRACE,
		PWL_DEBUG,
		PWL_INFO,
		PWL_WARN,
		PWL_ERROR,

		_PWL_AFTER_LAST,
	} PW_LOG_LEVEL;

	/// pw_init
	///
	/// Initialize a rule in the PowerWAF
	/// Must be called before calling RunPowerWAF on this rule name
	/// Will clear any existing rule with the same name
	///

	typedef struct
	{
		uint64_t maxArrayLength;
		uint64_t maxMapDepth;
	} PWConfig;

	///
	/// @param ruleName Name the atom that provided the patterns we're about to initialize with
	/// @param wafRule JSON blob containing the patterns to work with
	/// @param config Customized limits for the PWArgs validation
	/// @param errors Pointer to the pointer to be populated with a potential error report. Set to NULL not to generate such a report
	/// @return The success (true) or faillure (false) of the init

	extern bool pw_init(const char* ruleName, const char* wafRule, const PWConfig* config, char** errors);

	/// RunPowerWAF
	///
	/// Run the patterns from a rule on a set of parameters
	///

	typedef struct
	{
		PW_RET_CODE action;
		const char* data;
		const char* perfData;

		uint32_t perfTotalRuntime;
		uint32_t perfCacheHitRate;
	} PWRet;

	///
	/// Threading guarantees: When calling this API, a lock will be taken for a very short window as this call will take ownership of a shared smart pointer.
	/// 	This pointer implement reference counting and can be owned by as many thread as you want.
	/// 	If you call pw_init while evaluation of pw_run is ongoing, the calls having already taken ownership will safely finish processing.
	/// 	The shared pointer will be destroyed, without locking pw_init, when the last pw_run finish processing.
	///
	/// Maximum budget: The budget is internally stored in nanoseconds in an int64_t variable. This is then added to the current time, also coded in nano seconds.
	/// 	Due to those convertions, the maximum safe value for the next 15 years is 2^52. After that, 2^51.
	///
	/// @param ruleName Name of the rule you want to run
	/// @param parameters The request's parameters
	/// @param timeLeftInUs The maximum time in microsecond PowerWAF is allowed to take
	/// @return Whether the pattern matched or whether we encountered an error

	extern PWRet pw_run(const char* ruleName, const PWArgs parameters, uint64_t timeLeftInUs);

	/// pw_clearRule
	///
	///	Flush all context related to a rule
	///
	/// @param ruleName Name of the rule to unload

	extern void pw_clearRule(const char* ruleName);

	/// ClearAll
	///
	///	Flush all context

	extern void pw_clearAll(void);

	///
	/// The following APIs (handle API) give the caller the full responsibility of the lifecycle of the wafHandle
	/// Freeing this handle while another run is in progress will cause crashes or worst.
	/// Don't use this API unless you understand the consequence and can provide 100% guarantee around it.
	/// In exchange for this risk, your handle isn't added to the registry and access won't involve our internal mutex
	///

	/// pw_initH
	///
	/// Initialize a rule in the PowerWAF, and return a handle
	///
	/// @param wafRule JSON blob containing the patterns to work with
	/// @param config Customized limits for the PWArgs validation
	/// @param errors Pointer to the pointer to be populated with a potential error report. Set to NULL not to generate such a report
	/// @return The handle of the initialized rule on success, NULL overwise

	extern PWHandle pw_initH(const char* wafRule, const PWConfig* config, char** errors);

	/// pw_runH
	///
	/// Run the patterns from a handle on a set of parameters
	///
	/// Threading guarantees: When calling this API, you're on your own.
	/// 	Calling clearRuleH while a pw_runH is running will likely cause a use after free and a crash
	/// 	Unless you _know_ what you're doing, use the safe API
	///
	/// Maximum budget: The budget is internally stored in nanoseconds in an int64_t variable. This is then added to the current time, also coded in nano seconds.
	/// 	Due to those convertions, the maximum safe value for the next 15 years is 2^52. After that, 2^51.
	///
	/// @param wafHandle The rule handle
	/// @param parameters The request's parameters
	/// @param timeLeftInUs The maximum time in microsecond PowerWAF is allowed to take
	/// @return Whether the pattern matched or whether we encountered an error

	extern PWRet pw_runH(const PWHandle wafHandle, const PWArgs parameters, uint64_t timeLeftInUs);

	/// pw_clearRuleH
	///
	///	Destroy a WAF handle
	///
	/// @param wafHandle handle to destroy

	extern void pw_clearRuleH(PWHandle wafHandle);

	///
	/// Additive API
	///
	/// pw_initAdditive
	///
	/// Create a additive context you can use with pw_runAdd
	/// Similarly to the handle API, you must call pw_clearAdditive at the end of the request to free caches
	/// You must make sure that the context isn't in use in pw_runAdditive when or after calling pw_clearAdditive
	///
	/// @param ruleName Name of the rule you want to run (managed API)
	/// @return A pointer to an additive context, or NULL if something went wrong

	PWAddContext pw_initAdditive(const char* ruleName);

	/// pw_initAdditiveH
	///
	/// Similar to pw_initAdditive but for the handle API
	///
	/// @param powerwafHandle The rule handle
	/// @return A pointer to an additive context, or NULL if something went wrong

	PWAddContext pw_initAdditiveH(const PWHandle powerwafHandle);

	/// pw_runAdditive
	///
	/// Run the rules affiliated with an additive context on some new parameters
	///
	/// Important considerations:
	///		You can call this API multiple time with the same context, and it will run on all new and past parameters
	///		When sending PWArgs to this API, the additive context take ownership of the PWArgs and will take care of freeing it
	///		When passing a parameter you already passed, further runs will ignore the past values
	///
	/// @param context The additive context for this request
	/// @param newArgs The newly available parameters
	/// @param timeLeftInUs The maximum time in microsecond PowerWAF is allowed to take
	/// @return Whether the pattern matched or whether we encountered an error

	PWRet pw_runAdditive(PWAddContext context, PWArgs newArgs, uint64_t timeLeftInUs);

	/// pw_clearAdditive
	///
	/// Destroy the additive API context
	/// Also take care of freeing any parameter sent to the context
	///
	/// @param context The additive context to free

	void pw_clearAdditive(PWAddContext context);

	/// pw_freeDiagnotics
	///
	/// Free the error report generated by pw_init
	///
	/// @param errors Pointer to a populated error report. NULL will be safely ignored

	extern void pw_freeDiagnotics(char* errors);

	/// pw_freeReturn
	///
	/// Free the buffers in the PWRet structure returned by pw_run
	///
	/// @param output Structure provided by pw_run

	extern void pw_freeReturn(PWRet output);

	/// GetVersion
	///
	/// Return the API version of PowerWAF
	///

	typedef struct
	{
		uint16_t major;
		uint16_t minor;
		uint16_t patch;
	} PWVersion;

	///
	/// @return The API version in SemVer form

	extern PWVersion pw_getVersion(void);

	///
	/// Callback that powerwaf will call to relay messages to the binding.
	///
	/// @param level The logging level
	/// @param function The native function that emitted the message. Never NULL
	/// @param file The file of the native function that emmitted the message. Never null
	/// @param line The line where the message was emmitted. Non-negative
	/// @param message The size of the logging message. NUL-terminated
	/// @param message_len The length of the logging message (excluding NUL terminator)
	///

	typedef void (*pw_logging_cb_t)(
		PW_LOG_LEVEL level, const char* function, const char* file, int line,
		const char* message, uint64_t message_len);

	///
	/// Sets up PowerWAF to rely logging messages to the binding
	///
	/// @param cb The callback to call, or NULL to stop relaying messages
	/// @param min_level The minimum logging level for which to relay messages (ignored if cb is NULL)
	/// @return whether the logging sink was successfully replaced
	///
	bool pw_setupLogging(pw_logging_cb_t cb, PW_LOG_LEVEL min_level);

	/// PWArgs utils

	extern PWArgs pw_getInvalid(void);
	extern PWArgs pw_createStringWithLength(const char* string, uint64_t length);
	extern PWArgs pw_createString(const char* string);
	extern PWArgs pw_createInt(int64_t value);
	extern PWArgs pw_createUint(uint64_t value);
	extern PWArgs pw_createArray(void);
	extern PWArgs pw_createMap(void);
	extern bool pw_addArray(PWArgs* array, PWArgs entry);
	// Setting entryNameLength to 0 will result in the entryName length being re-computed with strlen
	extern bool pw_addMap(PWArgs* map, const char* entryName, uint64_t entryNameLength, PWArgs entry);
	extern void pw_freeArg(PWArgs* input);

	/// Allocation utils to access PowerWAF's heap
	/// If you're using the following two PWArgs util, make sure the memory is owned by libSqreen!
	extern void* pw_memAlloc(uint64_t size);
	extern void* pw_memRealloc(void* ptr, uint64_t size);
	extern void pw_memFree(void* ptr);

	/// Those APIs take ownership of your pointers: those may be free-ed at any time by libSqreen. Only use them with pointer allocated with pw_mem*
	extern PWArgs pw_initString(const char* string, uint64_t length);
	extern bool pw_addMapNoCopy(PWArgs* map, const char* entryName, uint64_t entryNameLength, PWArgs entry);

#ifdef __cplusplus
}
#endif /* __cplusplus */

#endif /* pw_h */
