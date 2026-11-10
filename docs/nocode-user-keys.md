# No Code per-user gateway keys and the Tigo budget (piece A4)

Implements sections 6 and 8 of the shared contract `tigo-nocode-contract.md`
(convertigo/c8oprj-tigoaccess#5, tracking convertigo/c8oprj-tigoaccess#1) in the Agent Bridge and the Assistant.
Branches `feat/nocode-user-keys` of both repositories.

## Credential path

```text
Assistant (user's HTTP request, server side)
  C8Oforms.APIV2_TigoUserKey   (piece A3, under the log4j MDC nolog)
    -> key kept in context.server: lib_ConvertigoAssistant.gatewayKey.<random, one per key>
       {key, owner, generation, expiresAt}: 10 minutes for new starts, at least 5 left when a turn starts,
       forgotten 2 hours after its lifetime (index lib_ConvertigoAssistant.gatewayKey.index)
       the HTTP session of its owner holds the handle (lib_ConvertigoAssistant.gatewayKeyHandle)
  -> gatewayKeyHandle on agent_*_setup/start/prompt and agent_settings (masked sequence variable)
Bridge
  userGatewayCredential(handle): format, expiry, owner = userId, key format
  -> CONVERTIGO_LLM_API_KEY (Vibe) or ANTHROPIC_AUTH_TOKEN (Claude Code on a gateway model)
     in the process environment only
```

- **When:** a No Code session (`normalizeSkillProfile` is `nocode`) on a server (not Studio mode) whose C8Oforms
  has `APIV2_TigoUserKey` and that is registered with TigoAccess (global symbol `C8Oforms.tigo.server.id`, piece A3;
  without it C8Oforms answers `not_configured`) (`userGatewayKeysOn`). Once seen, the mode stays on until the engine restarts
  (`lib_ConvertigoAgentBridge.userGatewayKeysSeen`), so a C8Oforms reloaded without the sequence brings back neither
  the server key nor unconfined agents. The Studio key-file path (TigoAccess, `agents/convertigo/llm-api-key`) is
  unchanged, and so is a No Code server whose C8Oforms never issued user keys.
- **Who:** the handle is random (it cannot be computed from a user id). The HTTP session that obtained the key holds
  it, and a cached key is served only to that session while its user is the key's owner. A handle that comes with a
  request is dropped. A conversation of another account is refused (`conversation_not_owned`). The Bridge requires
  the bundle's owner to equal the call's user, both non-empty.
- **`context.server` is engine-wide:** any Rhino code of the engine can read it, so a low-code project co-hosted on a
  No Code server can read these keys (and the No Code MCP tokens). On such a server, no MCP bearer other than
  WEB_ADMIN may run server code or do authoring: the No Code token has no execution right. Operators should not
  co-host untrusted low-code projects there.
- **Lifetime:** a key past its lifetime starts nothing. A running process goes on with the key it holds (the Bridge
  accepts it by fingerprint at a prompt, for image description and for the Claude Code probe).
- **Expiry in LiteLLM (A1/A2):** a server key expires 120 min after its last get, and each get that finds less than
  90 min left pushes it back (same key); after expiry, the next get gives generation + 1.
  - The Assistant never keeps a key past its `expiresAt` minus 15 min.
  - While a turn of its own session runs, the Assistant asks again for the key each time its 10 minutes in memory are
    over (`keepUserGatewayKeyAlive`, on the panel's event reads). The same key then stays alive however long the turn.
  - An expired or rejected key (HTTP 401, "Expired Key", Vibe's "Invalid API key") is never read as a budget. The turn
    ends with "send your message again", and the next message gets a fresh key (a new one restarts the process).
- **Never in an event:** an agent with a shell can print its own key. `pushEvent` replaces it with `sk-***` in every
  event (panel, conversation records, feedback, stderr).
- **Never on disk:** the per-user branch of `bootstrapVibeHome` writes no `.env`. `scrubGatewayKeyFromEnvFile` removes the server key and its
  marker from a home written before. `vibeGatewayKeyStore` refuses (`user_keys_managed`). The process does not
  inherit `CONVERTIGO_LLM_API_KEY` from the engine (`entry.unsetEnv`, applied by `startProcess`). The entry keeps only
  the handle and a fingerprint. Vibe 3.1 lets a non-empty process variable win over its `.env`
  (`vibe/core/config/vibe_schema.py:load_dotenv_values`).
- **Fail closed, no fallback:** `convertigoGatewayApiKey` returns the user's key or nothing. The key file, a home
  `.env` and a raw `gatewayApiKey` option are all ignored. Missing, expired, malformed or foreign handle:
  `gateway_credential_missing`, at start (Vibe, Claude Code on a gateway model) and at each Vibe prompt.
- **Auxiliary calls:** image description runs on the entry's handle (`describeImagesForBlindModel`). The catalogue
  and effort probes get the user's key or none: without a key they keep the cached offer. Preview capture makes no
  gateway call in the Bridge. The MCP tools that call the gateway (`image-describe`, `subagent-run`, `browser-verify`,
  `project-lint`) read the workspace key file, and they refuse No Code bearers.
- **Restart on a new key:** `vibeStart` and `claudeStart` compare the key fingerprint with the running entry's and
  restart the process (Vibe resumes its session), as for a new MCP token.
- **Codex** has no gateway path.
- **Gateway URL:** `https://llm.convertigo.com/v1`, unless the operator sets the global symbol `agentbridge.gateway.url`.
  It must be an https URL, or http on this machine (loopback, `host.docker.internal`); a staging gateway or the
  end-to-end test double uses it. Vibe's config, Claude Code's base URL, the catalogue and effort probes, and image
  description all follow it. The `baseUrl` that TigoAccess gives with a key is not used.

## Budget exhaustion

- `gatewayBudgetError` reads LiteLLM 1.99.1's refusal: HTTP 429, type `budget_exceeded`, and messages naming
  `Key=`, `User=… in Team=`, `Team=`, `ExceededBudget: User=` / `End User=`. It returns
  `{code: "budget_exceeded", scope: member|team|key|user|unknown, retryable: false}`.
  An RPM/TPM limit ("Rate limit exceeded for …") or an upstream 429 is not a budget.
- `pushEvent` normalizes every `turn/error`, `acp/response_error`, `error` and `turn/failed` event, and redacts
  `stderr` lines. Only the code, scope, `retryable`, the request id and provider, and a neutral message remain. The
  gateway message and any entity id are dropped.
- **Vibe** retries every 429 for up to `api_retry_max_elapsed_time` (300 s by default). Vibe 3.1 then reports any 429
  as ACP `-31001 "Rate limit exceeded"` without the body. `sandbox/python/c8o_gateway_budget.py` (loaded by
  `sitecustomize.py` when `C8O_GATEWAY_BUDGET_HOOK=1`, every Vibe on the gateway) patches the harness's
  `_provider_failure._is_retryable`. A budget 429 is then not retried, and one marker line goes to stderr:
  `C8O_GATEWAY_BUDGET_EXCEEDED {"scope": …}`. The Bridge turns it into the error of the turn (`noteGatewayBudgetMarker`;
  `awaitGatewayBudgetMarker` covers the race between the stdout and stderr readers). Checked against the installed
  mistral-vibe 3.1.0 (`VIBE_TEST_PYTHON` test).
- **Claude Code** retries every 429 on its status alone. Its first `api_retry` 429 of a turn, on a gateway model, asks
  the gateway once (`probeGatewayBudget`, one request that a used-up budget refuses before any model call). A budget
  error then ends the turn and interrupts Claude Code. A rate limit keeps its retries.
- **Codex:** an `error` with `willRetry: true` no longer ends the turn.
- **Image description** stops at the first budget refusal. The prompt is then not sent, and `vibePrompt` answers the
  normalized error. **Effort probes** stop at the first budget refusal.

## Process isolation (validation required: securite-cve)

Requirement: on a multi-user server, an agent must not read another agent's `/proc/<pid>/environ`, where its user's
key is.

| Option | Assessment |
| --- | --- |
| `hidepid` on `/proc` | Hides only the processes of other uids. Every agent runs as the engine's user, so it protects nothing without one uid per agent. Rejected. |
| One system user per agent | Needs a privileged helper (setuid or root) and per-user homes and permissions. The engine's container refuses its own `/proc`, and probably uid changes too. Most invasive. Not done. |
| `/proc` denied under the Landlock helper | Already in place for confined No Code Vibe: `AGENT_SANDBOX_SYSTEM_READ_ONLY` gives `/proc/self`, `/proc/thread-self` and system-wide files only. Landlock also refuses ptrace across domains (since ABI 1), and reading `/proc/<pid>/environ` is a ptrace read access. **Chosen.** |

**Implemented** (`userGatewayKeyIsolationRefusal`, after the security review of 10/11): on a server with per-user
keys (registered, or seen since the engine started: `serverUsesUserGatewayKeys`), every agent of every profile and
caller (a WEB_ADMIN low-code session too) runs only if it cannot read another agent's environment:

- Vibe confined by Landlock under `files` or `mcp-only`: allowed.
- `sandboxed-shell` is capped to `files` on such a server (`engineNoCodeToolInfo`; the panel shows the configured
  policy). With a shell, the agent read its own key, which then reached the model and Vibe's own journal on disk.
  The cap stays until Vibe keeps the key out of `os.environ` and sets `PR_SET_DUMPABLE=0`.
- `mcp-only` without Landlock: refused, since `run_typescript` is not proven isolated.
- Vibe under `full`, any agent of another profile, Claude Code and Codex (never confined): refused with
  `agent_isolation_unavailable`. A process started unconfined before the server had per-user keys is stopped at its
  next start.

The Studio and servers that never had per-user keys are unchanged.

**What securite-cve must validate** (not validated yet):

1. **T1** on the target kernel (test-nocode: Linux 5.15, Landlock ABI 1), during A5:
   `sandbox/c8o-agent-isolation-test.sh HELPER [PYTHON] [ENGINE_PID]`, run in the pod as the engine's user.
   It starts two confined agents (one under an unconfined parent, the guard's place). From the first one it checks
   `environ`, `cmdline`, `mem`, `task/<pid>/environ`, `fd` and `root` of the other agent, of the guard and of the
   engine, through `cat`, Python `open()`, `PTRACE_ATTACH` and `process_vm_readv`. Every check must be refused.
   Two controls prove the setup: an agent reads its own `/proc/self`, and an unconfined process reads the marker.
   It prints PASS/FAIL only, never what it read.
   For test-nocode: the helper is `<project lib_ConvertigoAgentBridge>/sandbox/linux-amd64/c8o-agent-sandbox`, the
   Python is the managed one (`<workspace>/agents/runtimes/python/.../bin/python3`), the engine pid is the JVM's.
   It passes in the helper's CI (GitHub runners, amd64 and arm64, Landlock ABI 8) and under Docker Desktop
   (linuxkit 7.0, ABI 8). ABI 1 is the A5 run.
2. Confined agents and the engine: covered by T1.
3. `mcp-only` is accepted only when confined (T3), so `run_typescript` needs no separate proof.
4. The parent-death guard (`agentGuardedCommand`, an unconfined Node process outside the helper) has the same
   environment, key included. It runs only Bridge code: check that nothing an agent controls runs in it.
5. Nothing else of the engine's user that is unconfined runs code an agent controls on that server (other tools, a
   shell for operators).
6. Residual risks, to confirm or close:
   - `sandboxed-shell` is capped to `files` with per-user keys (above). Lifting the cap needs a hardened Vibe: the key
     taken out of `os.environ` by the startup hook so that tools do not inherit it, and `PR_SET_DUMPABLE=0`. Before
     Landlock ABI 6, a shell can also signal other agents.
   - Under `files`, Vibe's own `read_file` stays in the session folder (`outside_workdir = "deny"`, and the Bridge
     refuses the permission request otherwise: T2). The key never reaches the agent through a tool.
   - The key sits in the engine's memory (`context.server`): 10 minutes for new starts, then up to 2 hours for
     running processes before it is purged.
   - `/proc/self` is bound to the helper's pid (the agent's), so a child process does not see its own `/proc/self`
     (existing behaviour).

## Tests

- `tests/nocode_user_key_security.test.js`: T1 to T8 of the security review.
  - T1: the isolation script matches the Bridge's confinement, and the CI runs it.
  - T2: `read_file("/proc/self/environ")` is refused under `files` and `mcp-only`.
  - T3: `mcp-only` is accepted only when confined.
  - T4: every unconfined agent of every profile is refused, a reused one too.
  - T5: a dummy key reaches no log, event, status, refusal or written file.
  - T6: another user's id or handle is refused.
  - T7: `sandboxed-shell` is capped to `files`.
  - T8: a key past its lifetime, then purged, fails closed.
  - The Assistant's side of T5, T6 and T8 is in lib_ConvertigoAssistant `tests/tigo_budget_gate.test.cjs`.
- `tests/nocode_user_gateway_key.test.js`: mode, handle resolution, no fallback, refusals, environment, `.env`
  scrub, isolation, masked sequence variables.
- `tests/gateway_budget_exceeded.test.js`: classifier (every scope, RPM/TPM, upstream, runtime rate limits), event
  normalization, Vibe marker, Codex `willRetry`, Claude probe, effort probes, Python parity.
  `VIBE_TEST_PYTHON=<venv python>` also runs the hook in Vibe's real retry loop.
- `tests/nocode_image_describe.test.js`: a used-up budget stops the descriptions and the prompt.

## Waiting for

- **A3** (C8Oforms): `APIV2_TigoUserKey` and `APIV2_TigoUserQuota`, on C8Oforms `design/tigo-server-keys`
  with the shapes read here. Until a server has them and is registered, nothing changes on it.
- The Studio's TigoAccess `getQuota` of a managed team's key also carries `contract`, the section 5 shape (A1/A2).
  `effectiveTigoBalance` reads it first.
- **A1/A2** (TigoAccess): the keys and quotas those sequences relay.
- **securite-cve:** the validation above, before production.
- **A5** (test-nocode): end-to-end with a test team, and removal of the shared key file.
