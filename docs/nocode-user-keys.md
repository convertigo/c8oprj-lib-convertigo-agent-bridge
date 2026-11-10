# No Code per-user gateway keys and the Tigo budget (piece A4)

Implements sections 6 and 8 of the shared contract `tigo-nocode-contract.md`
(convertigo/c8oprj-tigoaccess#5, tracking convertigo/c8oprj-tigoaccess#1) in the Agent Bridge and the Assistant.
Branches `feat/nocode-user-keys` of both repositories.

## Credential path

```text
Assistant (user's HTTP request, server side)
  C8Oforms.APIV2_TigoUserKey   (piece A3, under the log4j MDC nolog)
    -> key kept in context.server: lib_ConvertigoAssistant.gatewayKey.<hash of the user>
       {key, owner, generation, expiresAt}: 10 minutes for new starts, at least 5 left when a turn starts,
       forgotten 2 hours after its lifetime (index lib_ConvertigoAssistant.gatewayKey.index)
  -> gatewayKeyHandle on agent_*_setup/start/prompt and agent_settings (masked sequence variable)
Bridge
  userGatewayCredential(handle): format, expiry, owner = userId, key format
  -> CONVERTIGO_LLM_API_KEY (Vibe) or ANTHROPIC_AUTH_TOKEN (Claude Code on a gateway model)
     in the process environment only
```

- **When:** a No Code session (`normalizeSkillProfile` is `nocode`) on a server (not Studio mode) whose C8Oforms
  has `APIV2_TigoUserKey` (`userGatewayKeysOn`). Once seen, the mode stays on until the engine restarts
  (`lib_ConvertigoAgentBridge.userGatewayKeysSeen`), so a C8Oforms reloaded without the sequence brings back neither
  the server key nor unconfined agents. The Studio key-file path (TigoAccess, `agents/convertigo/llm-api-key`) is
  unchanged, and so is a No Code server whose C8Oforms never issued user keys.
- **Who:** the Assistant keys the handle on the user of the session, and refuses a conversation of another account
  (`conversation_not_owned`). The Bridge requires the bundle's owner to equal the call's user, both non-empty.
- **Lifetime:** a key past its lifetime starts nothing. A running process goes on with the key it holds (the Bridge
  accepts it by fingerprint at a prompt, for image description and for the Claude Code probe).
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

**Implemented** (`userGatewayKeyIsolationRefusal`): with per-user keys on, a No Code agent runs only if it cannot read
another agent's environment:

- Vibe confined by Landlock: allowed.
- Vibe under `mcp-only` (no native file or shell tool, Landlock missing): allowed.
- Vibe under `full`: refused with `agent_isolation_unavailable`.
- Claude Code and Codex in No Code (never confined): refused with `agent_isolation_unavailable`.

The Studio and servers without per-user keys are unchanged.

**What securite-cve must validate** (not validated yet):

1. On the target kernel (test-nocode: Linux 5.15, Landlock ABI 1), two confined agents of two users cannot read each
   other's `/proc/<pid>/environ`, `cmdline` or `mem`. Test both through the path rules and through ptrace: `cat`,
   `python -c "open('/proc/PID/environ')"`, `process_vm_readv`.
   `sandbox/c8o-agent-sandbox-test.sh` now checks two confined agents against each other (environment, command
   line, threads) next to a confined one against an unconfined one. It passed locally under Docker Desktop
   (linuxkit 7.0, arm64, Landlock ABI 8). There, a Python `open()` and a `ptrace(PTRACE_ATTACH)` from one confined
   agent to the other were refused too, while an unconfined process of the same user read the key. That is why
   unconfined agents are refused. ABI 1 is not checked.
2. A confined agent cannot reach the engine's memory or environment, or another agent's: `/proc/<engine pid>/…`,
   `/proc/<pid>/root`, `/proc/<pid>/fd`, `/proc/<pid>/task/*/environ`.
3. `mcp-only` really leaves no native file or shell tool: `run_typescript`, background processes and subagents are
   off. If any remains, `mcp-only` must not count as isolated.
4. The parent-death guard (`agentGuardedCommand`, an unconfined Node process outside the helper) has the same
   environment, key included. It runs only Bridge code: check that nothing an agent controls runs in it.
5. Nothing else of the engine's user that is unconfined runs code an agent controls on that server (other tools, a
   shell for operators).
6. Residual risks, to confirm or close:
   - Under `sandboxed-shell`, the agent can read its own user's key: `echo $CONVERTIGO_LLM_API_KEY`, or
     `/proc/<vibe-acp pid>/environ`, which its domain may read. It could leak the key if prompt-injected; the damage
     is bounded by that user's own budget, and the key can be revoked.
     The Bridge redacts the key in its events, but what Vibe writes itself (its session journal under `VIBE_HOME`,
     on disk) and what goes to the model keep it. That goes against decision 7 ("never written to disk") in that
     case.
     **Decision needed:** cap per-user mode to `files` / `mcp-only`, or harden Vibe: `PR_SET_DUMPABLE=0`, plus the key
     taken out of `os.environ` by the startup hook so that tools do not inherit it.
   - The key sits in the engine's memory (`context.server`): 10 minutes for new starts, then up to 2 hours for
     running processes before it is purged.
   - `/proc/self` is bound to the helper's pid (the agent's), so a child process does not see its own `/proc/self`
     (existing behaviour).

## Tests

- `tests/nocode_user_gateway_key.test.js`: mode, handle resolution, no fallback, refusals, environment, `.env`
  scrub, isolation, masked sequence variables.
- `tests/gateway_budget_exceeded.test.js`: classifier (every scope, RPM/TPM, upstream, runtime rate limits), event
  normalization, Vibe marker, Codex `willRetry`, Claude probe, effort probes, Python parity.
  `VIBE_TEST_PYTHON=<venv python>` also runs the hook in Vibe's real retry loop.
- `tests/nocode_image_describe.test.js`: a used-up budget stops the descriptions and the prompt.

## Waiting for

- **A3** (C8Oforms): `APIV2_TigoUserKey` and `APIV2_TigoUserQuota` with the shapes above (proposed on #1).
  Until they exist, everything here stays off on a server.
- **A1/A2** (TigoAccess): the keys and quotas those sequences relay.
- **securite-cve:** the validation above, before production.
- **A5** (test-nocode): end-to-end with a test team, and removal of the shared key file.
