// Shipped by the Convertigo Agent Bridge (playwrightMcpGuardedLaunch copies it into <agents>/guard/).
// A stdio MCP proxy in front of the Playwright MCP server of a managed agent runtime:
//   node playwright_guard.cjs -- <command> [args...]
// browser_wait_for takes `time` in seconds and stops at 30. Mistral Large 4 passed milliseconds ({time: 2500}) and so
// waited 30 s each time: 71 waits, 35 minutes of a 95-minute run. The proxy passes every newline-delimited JSON-RPC
// message through unchanged, except:
// - a tools/call of browser_wait_for (or of a namespaced name ending in browser_wait_for): a numeric `time` above 30
//   and from 100 up is read as milliseconds (divided by 1000), then any numeric `time` is kept within 0..30;
//   `text` and `textGone` are left alone;
// - a tools/list answer: the `time` description of browser_wait_for says seconds, at most 30, e.g. 2 (not 2000).
// stderr, the exit code and the signals of the real server are kept. Node built-ins only.
"use strict";

const { spawn } = require("child_process");

const WAIT_TOOL = "browser_wait_for";
const MAX_WAIT_SECONDS = 30;
const MILLISECONDS_FROM = 100;
const TIME_NOTE = "In seconds, not milliseconds: at most " + MAX_WAIT_SECONDS + ", e.g. 2 for two seconds (not 2000).";

function isWaitTool(name) {
  if (typeof name !== "string") {
    return false;
  }
  if (name === WAIT_TOOL) {
    return true;
  }
  // mcp__playwright__browser_wait_for, playwright_browser_wait_for, playwright.browser_wait_for...
  return name.length > WAIT_TOOL.length && name.endsWith(WAIT_TOOL) && !/[A-Za-z0-9]/.test(name.charAt(name.length - WAIT_TOOL.length - 1));
}

// The `time` the server should get, in seconds within 0..30. Anything that is not a finite number is left alone.
function waitSeconds(time) {
  if (typeof time !== "number" || !Number.isFinite(time)) {
    return time;
  }
  let seconds = time;
  if (seconds > MAX_WAIT_SECONDS && seconds >= MILLISECONDS_FROM) {
    seconds = seconds / 1000;
  }
  if (seconds > MAX_WAIT_SECONDS) {
    seconds = MAX_WAIT_SECONDS;
  }
  if (seconds < 0) {
    seconds = 0;
  }
  return seconds;
}

function guardRequest(message) {
  if (!message || typeof message !== "object" || message.method !== "tools/call") {
    return false;
  }
  const params = message.params;
  if (!params || typeof params !== "object" || !isWaitTool(params.name)) {
    return false;
  }
  const args = params.arguments;
  if (!args || typeof args !== "object" || !Object.prototype.hasOwnProperty.call(args, "time")) {
    return false;
  }
  const seconds = waitSeconds(args.time);
  if (seconds === args.time) {
    return false;
  }
  process.stderr.write("playwright guard: " + params.name + " time " + args.time + " -> " + seconds + " s\n");
  args.time = seconds;
  return true;
}

function guardResponse(message) {
  if (!message || typeof message !== "object" || Object.prototype.hasOwnProperty.call(message, "method")) {
    return false;
  }
  const tools = message.result && Array.isArray(message.result.tools) ? message.result.tools : null;
  let changed = false;
  for (const tool of tools || []) {
    const time = tool && isWaitTool(tool.name) && tool.inputSchema && tool.inputSchema.properties ? tool.inputSchema.properties.time : null;
    if (!time || typeof time !== "object") {
      continue;
    }
    const previous = typeof time.description === "string" ? time.description : "";
    if (previous.indexOf(TIME_NOTE) === 0) {
      continue;
    }
    time.description = previous.length ? TIME_NOTE + " " + previous : TIME_NOTE;
    changed = true;
  }
  return changed;
}

// One line of the stream, rewritten by `guard` when it changes a message (a JSON-RPC batch counts as one), else
// returned byte for byte. `needle` is a cheap pre-check: most lines (snapshots, screenshots) are never parsed.
function rewriteLine(line, needle, guard) {
  if (line.indexOf(needle) < 0) {
    return line;
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch (_notJson) {
    return line;
  }
  let changed = false;
  for (const item of Array.isArray(message) ? message : [message]) {
    changed = guard(item) || changed;
  }
  return changed ? JSON.stringify(message) : line;
}

function rewriteClientLine(line) {
  return rewriteLine(line, WAIT_TOOL, guardRequest);
}

function rewriteServerLine(line) {
  return rewriteLine(line, WAIT_TOOL, guardResponse);
}

// Forwards `source` to `target` line by line through `rewrite`, with backpressure. A last line without its newline is
// forwarded as is when the source ends.
function pipeLines(source, target, rewrite, onEnd) {
  let parts = [];
  const write = (text) => target.write(text);
  source.setEncoding("utf8");
  source.on("data", (chunk) => {
    let start = 0;
    let at;
    let ok = true;
    while ((at = chunk.indexOf("\n", start)) !== -1) {
      parts.push(chunk.slice(start, at));
      const line = parts.join("");
      parts = [];
      ok = write(rewrite(line) + "\n") && ok;
      start = at + 1;
    }
    if (start < chunk.length) {
      parts.push(chunk.slice(start));
    }
    if (!ok && typeof target.once === "function") {
      source.pause();
      target.once("drain", () => source.resume());
    }
  });
  source.on("end", () => {
    const rest = parts.join("");
    parts = [];
    if (rest.length) {
      write(rewrite(rest));
    }
    if (onEnd) {
      onEnd();
    }
  });
}

function main(argv) {
  const at = argv.indexOf("--");
  const command = at >= 0 ? argv.slice(at + 1) : [];
  if (!command.length) {
    process.stderr.write("playwright guard: usage: node playwright_guard.cjs -- <command> [args...]\n");
    process.exit(2);
  }
  const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  let exiting = false;
  const finish = (code, signal) => {
    if (exiting) {
      return;
    }
    exiting = true;
    // what the server wrote is flushed before this process ends
    process.stdout.write("", () => {
      if (signal && process.platform !== "win32") {
        for (const name of FORWARDED_SIGNALS) {
          process.removeAllListeners(name);
        }
        try {
          process.kill(process.pid, signal);
          return;
        } catch (_ignoreSelfSignal) {}
      }
      process.exit(code === null || typeof code === "undefined" ? (signal ? 1 : 0) : code);
    });
  };
  child.on("error", (error) => {
    process.stderr.write("playwright guard: cannot start " + command[0] + ": " + (error && error.message ? error.message : error) + "\n");
    exiting = true;
    process.exit(127);
  });
  child.stdin.on("error", () => {});
  process.stdout.on("error", () => {
    try { child.kill("SIGTERM"); } catch (_ignoreKill) {}
  });
  pipeLines(process.stdin, child.stdin, rewriteClientLine, () => child.stdin.end());
  pipeLines(child.stdout, process.stdout, rewriteServerLine, null);
  child.on("close", finish);
  for (const name of FORWARDED_SIGNALS) {
    try {
      process.on(name, () => {
        try { child.kill(name); } catch (_ignoreForward) {}
      });
    } catch (_ignoreUnsupportedSignal) {}
  }
}

const FORWARDED_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];

module.exports = { isWaitTool, waitSeconds, rewriteClientLine, rewriteServerLine, TIME_NOTE };

if (require.main === module) {
  main(process.argv.slice(2));
}
