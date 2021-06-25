#define DEBUG     0

#include "PowerWAF.h"
#include <stdlib.h> // TODO(vdeturckheim): check if this one is still needed


#if DEBUG == 1
#include <stdio.h>
#define mlog(X, ...) {                                  \
    fprintf(stderr, "%s:%d ", __FUNCTION__, __LINE__);  \
    fprintf(stderr, X, ##__VA_ARGS__);                  \
}
#else
#define mlog(X, ...) { }
#endif

#if DEBUG == 1
#include <stdio.h>
void _logPWArgs(PWArgs args, uint64_t depth)
{
	for (uint64_t i = 0; i < depth; ++i)
	{
		putc(' ', stdout);
	}

	switch (args.type)
	{
		case PWI_INVALID:
		{
			printf("<INVALID>\n");
			break;
		}

		case PWI_SIGNED_NUMBER:
		{
			if (args.parameterName != NULL)
				printf("<INT>: {%s: %lld}\n", args.parameterName, args.intValue);
			else
				printf("<INT>: %lld\n", args.intValue);
			break;
		}

		case PWI_UNSIGNED_NUMBER:
		{
			if (args.parameterName != NULL)
				printf("<UINT>: {%s: %llu}\n", args.parameterName, args.uintValue);
			else
				printf("<UINT>: %llu\n", args.uintValue);
			break;
		}

		case PWI_STRING:
		{
			if (args.parameterName != NULL)
				printf("<STR>: {%s: %s}\n", args.parameterName, args.stringValue);
			else
				printf("<STR>: %s\n", args.stringValue);
			break;
		}

		case PWI_ARRAY:
		{
			if (args.parameterName != NULL)
				printf("<ARR>: {%s: %llu}\n", args.parameterName, args.nbEntries);
			else
				printf("<ARR>: %llu\n", args.nbEntries);

			for (uint64_t i = 0; i < args.nbEntries; ++i)
				_logPWArgs(args.array[i], depth + 1);
			break;
		}

		case PWI_MAP:
		{
			if (args.parameterName != NULL)
				printf("<MAP>: {%s: %llu}\n", args.parameterName, args.nbEntries);
			else
				printf("<MAP>: %llu\n", args.nbEntries);

			for (uint64_t i = 0; i < args.nbEntries; ++i)
				_logPWArgs(args.array[i], depth + 1);
			break;
		}
	}
}
#define logPWArgs(args)  _logPWArgs(args, 0)
#else
#define logPWArgs(args)
#endif
