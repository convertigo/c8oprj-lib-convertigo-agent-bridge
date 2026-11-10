# Copyright (c) 2001-2026 Convertigo SA.
#
# Imported by sitecustomize.py (C8O_GATEWAY_BUDGET_HOOK=1) in a vibe-acp that the Agent Bridge runs on the Convertigo
# LLM gateway. LiteLLM refuses a request over a budget (key, team member, team) with HTTP 429 and the error type
# budget_exceeded. Vibe's harness retries every 429 for up to api_retry_max_elapsed_time (300 s by default), and Vibe
# 3.1 then reports it as "Rate limit exceeded" (ACP -31001) without the gateway's body: a user with no budget left
# waited five minutes for an error that said nothing about the budget.
#
# The harness reads each failed provider call once (adapters/_provider_failure.read_provider_failure): its retry policy
# and the error the user sees both come from that reading, through the module function _is_retryable. Here that
# function answers False for a 429 whose body is a budget refusal, so the turn fails at once, and one line goes to
# stderr for the Agent Bridge: MARKER {"scope": "member"|"team"|"key"|"user"|"unknown"}. Neither the gateway's message
# nor any id or key is printed. An RPM/TPM limit or an upstream 429 keeps Vibe's retries.
import importlib.abc
import json
import re
import sys

MARKER = "C8O_GATEWAY_BUDGET_EXCEEDED"
TARGET = "mistralai_vibe_local_harness.vibe.adapters._provider_failure"

_TYPED = re.compile(r"(^|[^A-Za-z0-9_])budget_exceeded([^A-Za-z0-9_]|$)")
_WORDED = re.compile(r"Budget has been exceeded!|ExceededBudget:")


def budget_refusal(text):
    """True for the body (or message) of a LiteLLM budget refusal."""
    text = text or ""
    return bool(_TYPED.search(text) or _WORDED.search(text))


def budget_scope(text):
    """The level a LiteLLM budget message names, the same reading as gatewayBudgetScope in the Agent Bridge."""
    text = text or ""
    if re.search(r"\bUser=\S+\s+in\s+Team=", text):
        return "member"
    if re.search(r"\bEnd User=", text):
        return "user"
    if re.search(r"\bKey=|\bKey over\b", text):
        return "key"
    if re.search(r"\bTeam=", text):
        return "team"
    if re.search(r"ExceededBudget:\s*User=", text):
        return "user"
    return "unknown"


def _report(scope):
    try:
        sys.stderr.write(MARKER + " " + json.dumps({"scope": scope}) + "\n")
        sys.stderr.flush()
    except Exception:
        pass


def patch(module):
    """Wrap module._is_retryable; False when the module is not the expected one (another Vibe version)."""
    original = getattr(module, "_is_retryable", None)
    body_of = getattr(module, "_response_body", None)
    if not callable(original) or getattr(original, "_c8o_gateway_budget", False):
        return False

    def _is_retryable(error, response):
        if response is not None and getattr(response, "status", None) == 429:
            text = ""
            try:
                text = (body_of(error) if callable(body_of) else None) or ""
            except Exception:
                text = ""
            if not text:
                try:
                    text = str(error)
                except Exception:
                    text = ""
            if budget_refusal(text):
                _report(budget_scope(text))
                return False
        return original(error, response)

    _is_retryable._c8o_gateway_budget = True
    _is_retryable.__wrapped__ = original
    module._is_retryable = _is_retryable
    return True


class _PatchingLoader(importlib.abc.Loader):
    def __init__(self, inner):
        self._inner = inner

    def create_module(self, spec):
        return self._inner.create_module(spec)

    def exec_module(self, module):
        self._inner.exec_module(module)
        try:
            patch(module)
        except Exception:
            pass

    def __getattr__(self, name):
        return getattr(self._inner, name)


class _Finder(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path, target=None):
        if name != TARGET:
            return None
        for finder in sys.meta_path:
            if finder is self or not hasattr(finder, "find_spec"):
                continue
            spec = finder.find_spec(name, path, target)
            if spec is not None and spec.loader is not None and hasattr(spec.loader, "exec_module"):
                spec.loader = _PatchingLoader(spec.loader)
                return spec
        return None


def install():
    """Patch the harness when it is loaded (or now, when it already is)."""
    loaded = sys.modules.get(TARGET)
    if loaded is not None:
        return patch(loaded)
    if not any(isinstance(finder, _Finder) for finder in sys.meta_path):
        sys.meta_path.insert(0, _Finder())
    return True
