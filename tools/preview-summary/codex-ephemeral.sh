#!/bin/sh
# The SDK supplies "exec" first. Keep this integration out of conversation history.
command_name="$1"
shift
exec "${LOCAL_MONITOR_CODEX_BIN:-codex}" "$command_name" --ephemeral "$@"
