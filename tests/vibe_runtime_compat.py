"""Validate generated configuration and ACP serialization with an installed runtime.

Called by vibe_turn_nudge.test.js with VIBE_TEST_PYTHONS set to a JSON array of
Python executables. No credentials, network, model requests or user homes.
"""
import json
import os
from pathlib import Path
import socket
import sys
import tomllib


def offline(*_args, **_kwargs):
    raise AssertionError("Runtime contract tests must stay offline")


socket.socket.connect = offline
socket.create_connection = offline

from importlib.metadata import version
from acp.schema import PromptResponse
from vibe.acp.session_updates import replay_history_entry
from vibe.app_server.models import PublicMessageEntry
from vibe.core.config.vibe_schema import VibeConfigSchema
from vibe.core.config.harness_files import init_harness_files_manager


request = json.load(sys.stdin)
prompt_dir = Path(os.environ["VIBE_HOME"]) / "prompts"
prompt_dir.mkdir()
(prompt_dir / "convertigo_compact.md").write_text("Summarize the ongoing test task.")
init_harness_files_manager("user", "project")
config_data = tomllib.loads(request["config"])
assert "smart_approve_default" not in config_data
assert "default_agent" not in config_data
config = VibeConfigSchema.model_validate(config_data)
assert config.enable_system_trust_store is True
assert config.active_model == request["model"]


def message(text):
    entry = PublicMessageEntry(
        id="message-test", session_id="s1", turn_id="turn-test",
        created_at=1, updated_at=2, generation_status="completed",
        role="assistant", content=[{"type": "text", "text": text}],
    )
    return [
        {"jsonrpc": "2.0", "method": "session/update", "params": {
            "sessionId": "s1", "update": update.model_dump(mode="json", by_alias=True, exclude_none=True)
        }}
        for update in replay_history_entry(entry)
    ]


print(json.dumps({
    "version": version("mistral-vibe"),
    "profile": request["profile"],
    "printed": message('todo:{"action":"write","todos":[]}'),
    "announcement": message("Je vérifie les cas d'erreur en HTTP."),
    "complete": message("The requested checks passed."),
    "response": PromptResponse(stop_reason="end_turn").model_dump(mode="json", by_alias=True, exclude_none=True),
    "cancelled": PromptResponse(stop_reason="cancelled").model_dump(mode="json", by_alias=True, exclude_none=True),
}))
