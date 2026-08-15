// Test fixture: builds a temporary directory containing an executable `agy`
// shim that just echoes its piped stdin back to its stdout, optionally
// after a delay, and supports the subset of flags the companion passes
// (`--print`, `--print-timeout`, `--add-dir`, `--continue`, `--conversation`,
// `--dangerously-skip-permissions`). The fake never speaks to the network.
//
// Use writeFakeAgy() to install a fake agy in PATH; the returned object
// gives you the directory to prepend to PATH and a path to the script
// itself for assertions.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeExecutable } from "./helpers.mjs";

export const FAKE_AGY_SHELL = `#!/usr/bin/env bash
# Fake agy that echoes the piped stdin back to stdout.
# Recognized flags (otherwise ignored): --print, --print-timeout <v>, --add-dir <path>,
# --continue, --conversation <id>, --dangerously-skip-permissions.

mode=help
conv_id=""
delay_ms=0
expect_help=0
sleep_seconds=0

# Allow tests to inject a short sleep before responding.
if [ -n "$FAKE_AGY_SLEEP_MS" ]; then
  delay_ms="$FAKE_AGY_SLEEP_MS"
fi

# Record invocations when a test needs to assert agy flags. This is append-only
# because the companion first probes the binary with --help.
if [ -n "$FAKE_AGY_ARGS_LOG" ]; then
  printf '%s\\n' "$*" >> "$FAKE_AGY_ARGS_LOG"
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --help)
      expect_help=1
      shift
      ;;
    --print|--prompt|-p)
      mode=print
      shift
      ;;
    --print-timeout|--log-file|--add-dir)
      shift; shift
      ;;
    --conversation)
      conv_id="$2"
      shift; shift
      ;;
    --continue|-c)
      conv_id="last"
      shift
      ;;
    --dangerously-skip-permissions|--sandbox)
      shift
      ;;
    *)
      shift
      ;;
  esac
done

if [ "$expect_help" = "1" ]; then
  echo "Usage of fake agy: --print and friends."
  exit 0
fi

# Allow tests to force a non-zero exit *for print-mode runs only*.
if [ -n "$FAKE_AGY_EXIT" ]; then
  exit "$FAKE_AGY_EXIT"
fi

# Simulate a slow turn if requested (used by the timeout test).
if [ "$delay_ms" -gt 0 ]; then
  # bash sleep accepts seconds; round up.
  python3 -c "import time, sys; time.sleep(int(sys.argv[1])/1000.0)" "$delay_ms"
fi

if [ -n "$FAKE_AGY_CONVERSATIONS_DIR" ]; then
  mkdir -p "$FAKE_AGY_CONVERSATIONS_DIR"
  if [ -z "$conv_id" ]; then
    conv_id="$(uuidgen 2>/dev/null || python3 -c 'import uuid; print(uuid.uuid4())')"
  fi
  : > "$FAKE_AGY_CONVERSATIONS_DIR/$conv_id.pb"
fi

# Echo whatever was piped on stdin so tests can assert that the prompt
# round-tripped through the subprocess.
# FAKE_AGY_EMPTY_REPLY=1 suppresses all output (exit 0 with empty stdout).
if [ -n "$FAKE_AGY_EMPTY_REPLY" ]; then
  true
elif [ -n "$FAKE_AGY_REPLY" ]; then
  printf '%s' "$FAKE_AGY_REPLY"
else
  cat
fi
`;

export function writeFakeAgy(prefix = "fake-agy-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const scriptPath = path.join(dir, "agy");
  writeExecutable(scriptPath, FAKE_AGY_SHELL);
  return { dir, scriptPath };
}
