"""Convertigo plan sync: a Vibe post_tool hook that keeps the agent's todo list current.

The Convertigo assistant (Tigo) shows the user the agent's `todo` list as the plan of the turn. In long builds the
agent writes it at the start of a turn and then forgets it for dozens of minutes while it keeps
docs/generated/PROGRESS.md current, so the plan shown stays wrong. Instructions alone did not fix that.

Vibe runs this hook after every tool call (hooks.toml, type post_tool) and appends the hook's
`additional_context` to the tool result the model reads next. The hook appends a reminder when:
- the agent has just written PROGRESS.md and has not written its todo list since its previous PROGRESS.md write, or
- REMIND_EVERY tool calls went by without a todo write (and without a reminder).
The reminder quotes the todo list the agent last wrote and the "Lots" section of PROGRESS.md, so the agent can
write the right statuses at once. The todo list stays the agent's: nothing is rewritten for it.

Standard library only: it runs with the Python of Vibe's own virtual environment. Any error leaves the tool result
untouched (empty stdout, exit 0), so the hook can never break a tool call.
"""

import json
import os
import re
import sys
import tempfile

REMIND_EVERY = int(os.environ.get("CONVERTIGO_PLAN_SYNC_EVERY", "25") or "25")
STATE_FILE = "convertigo-plan-sync.json"
WRITE_TOOLS = ("write_file", "search_replace", "edit")
SHELL_TOOLS = ("bash", "git_bash", "windows_shell", "experimental_bash")
SHELL_WRITE = re.compile(r"(>|\btee\b|\bsed\s+-i|\bcp\b|\bmv\b|\bperl\s+-pi)")
LOTS_HEADING = re.compile(r"^#{1,4}\s*(lots?|plan|steps|étapes|etapes)\b", re.IGNORECASE)
MAX_SECTION_LINES = 20
MAX_SECTION_CHARS = 1500


def leaf_name(tool_name):
    # "vibe.todo", "file_system.write_file", "mcp_Convertigo.batch_call": the part after the last dot.
    return str(tool_name or "").rsplit(".", 1)[-1].lower()


def load_state(path):
    try:
        with open(path, encoding="utf-8") as handle:
            state = json.load(handle)
        if isinstance(state, dict):
            return state
    except (OSError, ValueError):
        pass
    return {}


def save_state(path, state):
    directory = os.path.dirname(path)
    descriptor, temporary = tempfile.mkstemp(prefix=".plan-sync-", dir=directory)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(state, handle)
        os.replace(temporary, path)
    except OSError:
        try:
            os.unlink(temporary)
        except OSError:
            pass


def progress_target(leaf, tool_input, cwd):
    """The PROGRESS.md path a successful call wrote, or None."""
    tool_input = tool_input if isinstance(tool_input, dict) else {}
    if leaf in WRITE_TOOLS:
        path = str(tool_input.get("file_path") or tool_input.get("path") or "")
        if os.path.basename(path).lower() == "progress.md":
            return path if os.path.isabs(path) else os.path.join(cwd or "", path)
        return None
    if leaf in SHELL_TOOLS:
        command = str(tool_input.get("command") or "")
        match = re.search(r"(\S*PROGRESS\.md)", command, re.IGNORECASE)
        if match and SHELL_WRITE.search(command):
            path = match.group(1).strip("'\"")
            return path if os.path.isabs(path) else os.path.join(cwd or "", path)
    return None


def lots_section(path):
    """The "Lots" (or plan / steps) section of PROGRESS.md, trimmed, or ""."""
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            lines = handle.read().splitlines()
    except OSError:
        return ""
    section = []
    inside = False
    for line in lines:
        if LOTS_HEADING.match(line):
            inside = True
            section = [line]
            continue
        if inside:
            if re.match(r"^#{1,4}\s", line):
                break
            if line.strip():
                section.append(line)
            if len(section) > MAX_SECTION_LINES:
                section.append("...")
                break
    text = "\n".join(section)
    return text[:MAX_SECTION_CHARS] + ("..." if len(text) > MAX_SECTION_CHARS else "")


def todo_lines(todos):
    lines = []
    for item in todos or []:
        if isinstance(item, dict) and str(item.get("content") or "").strip():
            lines.append("- [" + str(item.get("status") or "pending") + "] " + str(item.get("content")).strip()[:160])
    return lines[:30]


def reminder(reason, state, progress_path):
    calls = int(state.get("callsSinceTodo") or 0)
    if reason == "progress":
        lead = ("[Convertigo plan sync] You just updated PROGRESS.md, but your `todo` list was not written since your "
                "previous PROGRESS.md update. The Convertigo assistant shows the user only your `todo` list as the plan.")
    else:
        lead = ("[Convertigo plan sync] " + str(calls) + " tool calls since your last `todo` write. The Convertigo "
                "assistant shows the user only your `todo` list as the plan.")
    parts = [lead,
             "Call `todo` now (action \"write\", the full list): lots finished -> completed, the lot you work on -> "
             "in_progress, the others pending. Then continue your work."]
    previous = todo_lines(state.get("todos"))
    parts.append("Your todo list as last written:\n" + "\n".join(previous) if previous
                 else "You have not written a `todo` list yet in this session.")
    section = lots_section(progress_path) if progress_path else ""
    if section:
        parts.append("PROGRESS.md says:\n" + section)
    return "\n\n".join(parts)


def handle(event):
    """Update the session state for one post_tool event; return the reminder text or None."""
    root = str(event.get("transcript_path") or "")
    if not root or not os.path.isdir(root):
        return None
    state_path = os.path.join(root, STATE_FILE)
    state = load_state(state_path)
    leaf = leaf_name(event.get("tool_name"))
    success = event.get("tool_status", "success") == "success"
    tool_input = event.get("tool_input") if isinstance(event.get("tool_input"), dict) else {}

    if leaf == "todo":
        if success and tool_input.get("action") == "write":
            state.update({"callsSinceTodo": 0, "callsSinceReminder": 0, "progressSinceTodo": False,
                          "todos": [{"content": t.get("content"), "status": t.get("status")}
                                    for t in (tool_input.get("todos") or []) if isinstance(t, dict)]})
            save_state(state_path, state)
        return None

    state["callsSinceTodo"] = int(state.get("callsSinceTodo") or 0) + 1
    state["callsSinceReminder"] = int(state.get("callsSinceReminder") or 0) + 1
    progress_path = progress_target(leaf, tool_input, event.get("cwd")) if success else None
    reason = None
    if progress_path:
        if state.get("progressSinceTodo"):
            reason = "progress"
        state["progressSinceTodo"] = True
        state["progressPath"] = progress_path
    if reason is None and state["callsSinceTodo"] >= REMIND_EVERY and state["callsSinceReminder"] >= REMIND_EVERY:
        reason = "calls"
    text = None
    if reason:
        state["callsSinceReminder"] = 0
        state["reminders"] = int(state.get("reminders") or 0) + 1
        text = reminder(reason, state, progress_path or state.get("progressPath"))
    save_state(state_path, state)
    return text


def main():
    try:
        event = json.loads(sys.stdin.read() or "{}")
        text = handle(event) if isinstance(event, dict) else None
    except Exception:  # noqa: BLE001 - a broken hook must never touch the tool result
        return 0
    if text:
        sys.stdout.write(json.dumps({"hook_specific_output": {"additional_context": text}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
