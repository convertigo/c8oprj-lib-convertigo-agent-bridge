# Windows runtime installation diagnostics — Bridge 0.4.22

Convertigo 8.4.6 can load this bundle. The Windows installation failure reported
on 15 October 2026 occurred later, during runtime discovery:
`agent_settings`, `filePath`, `java.io.IOException` reporting invalid filename,
directory or volume syntax. The exact offending path on those PCs is still
unconfirmed. An older bundle is not a demonstrated workaround: the eager PATH
scan dates back to Bridge 0.2.13.

Runtime discovery now checks candidates in order and returns immediately when
an installed managed executable is found. It accepts surrounding Windows PATH
quotes, skips malformed or unresolvable entries, and continues to later valid
candidates. POSIX path handling stays literal. Diagnostics expose only the
source/index, path length and failure category, never the PATH contents or keys.

A full settings check on Windows also reads `LongPathsEnabled` without modifying
it, and creates then removes a temporary file on a path of at least 280 characters
under the workspace's `agents` directory. A short-path write failure is reported
as an inconclusive permissions/workspace check, not as proof of disabled long
paths. Results are cached for five minutes. Presence-only startup reuses the
cache and does not spawn registry/CLI commands or run the filesystem probe.

Assistant 1.4.47 displays actionable warnings in the runtime settings, with a
button opening the [Microsoft long path documentation](https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation).
Microsoft documents the per-process cache of the setting and the possibility
that a Windows restart is needed. A passing Java filesystem probe does not
prove that every Python, npm, launcher or third-party executable supports long
paths. No operating system setting is changed automatically.

After changing the Windows setting, restart Studio; restart Windows if needed,
then retry installation of the runtime if it was incomplete. Replacing the three
Convertigo projects and repairing a Python/Vibe runtime are separate operations.
The existing manually provided LiteLLM key must be retained.

Validation: Windows filesystem/registry behavior is modeled by
`node --test tests/windows_runtime_paths.test.js`; the project is loaded/exported
with the official 8.4.6 plugin. Native Windows acceptance remains to be performed
on the affected PCs.
