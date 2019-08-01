package main

// TODO: import trace agent when config no longer depends on viper
import (
	"syscall/js"
	"time"
)

func obfuscate(this js.Value, inputs []js.Value) interface{} {
	span := inputs[0]

	// TODO: use the trace agent to obfuscate
	if span.Get("type").String() == "sql" {
		span.Set("resource", "REDACTED")
		span.Set("sql.query", "REDACTED")
	}

	return span
}

func main() {
	agent := map[string]interface{}{
		"obfuscate": js.FuncOf(obfuscate),
	}

	js.Global().Set("__dd_agent__", agent)

	go forever() // TODO: find alternative way to keep Go alive
	select {}    // block forever
}

func forever() {
	for {
		time.Sleep(time.Second)
	}
}
