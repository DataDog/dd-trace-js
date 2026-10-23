from common import finish

from parity_langchain import chat_anthropic, chat_openai, openai_embeddings, start  # noqa: F401


start()
model = chat_openai(temperature=0).bind_tools(
    [
        {
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "Get the weather for a city.",
                "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
            },
        }
    ]
)
model.invoke([("user", "What is the weather in Paris?")])
finish()
