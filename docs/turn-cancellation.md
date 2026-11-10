# Bounded turn cancellation

The Assistant first asks `agent_interrupt` to stop a turn and keep the resident
session. The Bridge sends the provider's existing cancellation message and waits
for the turn to end (eight seconds by default). If it does not end, the Assistant
uses the provider close operation as its fallback.

Signal delivery is part of that wait budget. A process that stops reading stdin
must not hold the HTTP cancellation request indefinitely. Delivery runs on a daemon
thread; a delayed delivery checks the captured process and turn before writing.
An explicit close terminates the process tree before closing its buffered writer,
because closing that writer can wait on the same lock as a blocked write. The ACP
close fallback does not send another protocol request to the unresponsive process.

This stops the agent process, not necessarily work already running in an external
MCP server. Cancellation of that work requires the server's own cooperative
cancellation support. It does not roll back a completed mutation. A tool server
must check its cancellation signal at safe boundaries before starting more work.

Run `node --test tests/interrupt_budget.test.js` for the three protocol adapters,
stale-turn delivery and close ordering. The real JVM pipe witness and deterministic
CLI transport witnesses are separate qualification evidence; a unit result alone
does not qualify a particular Studio UI, remote server or provider version.
