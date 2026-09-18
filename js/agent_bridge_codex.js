// Codex CLI provider implementation.
// Loaded by vibe_agent_bridge.js after agent_bridge_common.js.

  function isConversationScopedCodexHome(value) {
    var text = trim(value).replace(/\\/g, "/");
    return text.indexOf("/conversations/") >= 0 && /\/codex-home\/?$/.test(text);
  }

  function codexItemText(item) {
    if (!item) {
      return "";
    }
    if (item.text !== null && typeof item.text !== "undefined") {
      return String(item.text);
    }
    if (item.content !== null && typeof item.content !== "undefined") {
      return extractContentText(item.content);
    }
    if (item.message !== null && typeof item.message !== "undefined") {
      return extractContentText(item.message);
    }
    if (item.delta !== null && typeof item.delta !== "undefined") {
      return extractContentText(item.delta);
    }
    return "";
  }

  function codexItemTitle(item) {
    if (!item) {
      return "";
    }
    return String(item.title || item.name || item.command || item.type || "");
  }

  function isCodexToolItem(itemType) {
    return itemType.indexOf("tool") >= 0 ||
      itemType.indexOf("command") >= 0 ||
      itemType.indexOf("exec") >= 0 ||
      itemType.indexOf("function") >= 0 ||
      itemType.indexOf("mcp") >= 0;
  }

  function isCodexReasoningItem(itemType) {
    return itemType.indexOf("reason") >= 0 ||
      itemType.indexOf("thought") >= 0 ||
      itemType.indexOf("plan") >= 0;
  }

  function codexContentText(content) {
    if (content === null || typeof content === "undefined") {
      return "";
    }
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray && Array.isArray(content)) {
      var parts = [];
      for (var i = 0; i < content.length; i++) {
        var part = codexContentText(content[i]);
        if (part.length) {
          parts.push(part);
        }
      }
      return parts.join("\n");
    }
    if (content.text !== null && typeof content.text !== "undefined") {
      return String(content.text);
    }
    if (content.output_text !== null && typeof content.output_text !== "undefined") {
      return String(content.output_text);
    }
    if (content.input_text !== null && typeof content.input_text !== "undefined") {
      return String(content.input_text);
    }
    if (content.message !== null && typeof content.message !== "undefined") {
      return codexContentText(content.message);
    }
    if (content.content !== null && typeof content.content !== "undefined") {
      return codexContentText(content.content);
    }
    return "";
  }

  function pushCodexProgress(entry, text, phase, source) {
    text = trim(text);
    if (!text.length || entry.lastCodexProgressMessage === text) {
      return;
    }
    entry.lastCodexProgressMessage = text;
    pushEvent(entry, "progress/message", {
      text: text,
      phase: phase || "commentary",
      source: source || "codex",
      provider: "codex"
    });
  }

  function pushCodexAnswer(entry, text, source) {
    text = trim(text);
    if (!text.length || entry.lastCodexAnswerChunk === text) {
      return;
    }
    entry.lastCodexAnswerChunk = text;
    pushEvent(entry, "answer/chunk", {
      text: text,
      phase: "final_answer",
      source: source || "codex",
      provider: "codex"
    });
  }

  function pushCodexRawChunk(entry, text, phase, source) {
    text = String(text || "");
    if (!trim(text).length) {
      return;
    }
    pushEvent(entry, "answer/chunk", {
      text: text,
      phase: phase || "final_answer",
      source: source || "codex",
      provider: "codex"
    });
  }

  function pushCodexProgressChunk(entry, text, phase, source) {
    text = String(text || "");
    if (!trim(text).length) {
      return;
    }
    pushEvent(entry, "answer/chunk", {
      text: text,
      phase: "commentary",
      progressPhase: phase || "commentary",
      source: source || "codex",
      provider: "codex"
    });
  }

  function codexAgentMessageLooksFinal(text, phase) {
    var p = String(phase || "").toLowerCase();
    if (p === "final_answer") {
      return true;
    }
    if (p === "commentary") {
      return false;
    }
    var raw = String(text || "");
    var compact = trim(raw.replace(/\s+/g, " "));
    if (!compact.length) {
      return false;
    }
    var lower = compact.toLowerCase();
    if (lower.indexOf("projets ouverts") === 0 || lower.indexOf("open projects") === 0) {
      return true;
    }
    if (lower.indexOf("aucune modification effectu") !== -1 || lower.indexOf("no change") !== -1) {
      return true;
    }
    if (lower.indexOf("validation faite") !== -1 || lower.indexOf("validated") !== -1) {
      return true;
    }
    var bulletCount = (raw.match(/\n\s*[-*]\s+/g) || []).length;
    if (bulletCount >= 3) {
      return true;
    }
    return compact.length >= 220 && (compact.indexOf(" - ") !== -1 || compact.indexOf(";") !== -1);
  }

  function pushCodexTurnEnd(entry, data) {
    if (entry.codexTurnEnded) {
      return;
    }
    entry.codexTurnEnded = true;
    entry.status = "completed";
    entry.phase = "completed";
    pushEvent(entry, "turn/end", data || {
      provider: "codex",
      threadId: entry.codexThreadId
    });
  }

  function codexToolTitleFromInvocation(invocation) {
    invocation = invocation || {};
    var tool = trim(invocation.tool || invocation.name);
    var server = trim(invocation.server);
    if (server.length && tool.length) {
      return server + "." + tool;
    }
    return tool.length ? tool : server;
  }

  function codexToolPreview(value) {
    if (value === null || typeof value === "undefined") {
      return "";
    }
    var text = "";
    if (typeof value === "string") {
      text = value;
    } else {
      try {
        text = JSON.stringify(value);
      } catch (_ignoreStringify) {
        text = String(value);
      }
    }
    text = trim(String(text).replace(/\s+/g, " "));
    if (!text.length || text === "{}" || text === "[]") {
      return "";
    }
    if (text.length > 1800) {
      text = text.substring(0, 1797) + "...";
    }
    return text;
  }

  function codexManagedSkillReadSlugs(value) {
    var text = trim(String(value || "")).replace(/\\/g, "/").replace(/\s+/g, " ");
    if (!text.length) {
      return [];
    }
    var lower = text.toLowerCase();
    var readsFile = lower.indexOf("sed -n") !== -1 ||
      lower.indexOf("cat ") !== -1 ||
      lower.indexOf("/bin/zsh -lc") !== -1 ||
      lower.indexOf("/bin/bash -lc") !== -1 ||
      lower.indexOf("zsh -lc") !== -1 ||
      lower.indexOf("bash -lc") !== -1;
    if (!readsFile) {
      return [];
    }
    var managedSlugs = [
      "convertigo-generalist",
      "convertigo-nocode",
      "convertigo-studio",
      "convertigo-flow-mcp",
      "convertigo-flow-backend",
      "convertigo-flow-frontend-svelte"
    ];
    var readSlugs = [];
    for (var i = 0; i < managedSlugs.length; i++) {
      if (lower.indexOf("skills/" + managedSlugs[i] + "/skill.md") !== -1) {
        readSlugs.push(managedSlugs[i]);
      }
    }
    return readSlugs;
  }

  function isCodexManagedSkillRead(value) {
    return codexManagedSkillReadSlugs(value).length > 0;
  }

  function isCodexManagedSkillReadItem(item) {
    if (!item) {
      return false;
    }
    var parts = [
      codexItemTitle(item),
      codexItemText(item),
      codexToolPreview(item.command),
      codexToolPreview(item.arguments),
      codexToolPreview(item.content),
      codexToolPreview(item.output),
      codexToolPreview(item.result)
    ];
    for (var i = 0; i < parts.length; i++) {
      if (isCodexManagedSkillRead(parts[i])) {
        return true;
      }
    }
    return false;
  }

  function codexManagedSkillReadSlugsFromItem(item) {
    if (!item) {
      return [];
    }
    var parts = [
      codexItemTitle(item),
      codexItemText(item),
      codexToolPreview(item.command),
      codexToolPreview(item.arguments),
      codexToolPreview(item.content),
      codexToolPreview(item.output),
      codexToolPreview(item.result)
    ];
    var found = {};
    for (var i = 0; i < parts.length; i++) {
      var slugs = codexManagedSkillReadSlugs(parts[i]);
      for (var j = 0; j < slugs.length; j++) {
        found[slugs[j]] = true;
      }
    }
    var result = [];
    for (var slug in found) {
      if (Object.prototype.hasOwnProperty.call(found, slug)) {
        result.push(slug);
      }
    }
    return result.sort();
  }

  function codexItemCallId(item) {
    item = item || {};
    return trim(item.call_id || item.callId || item.id);
  }

  function managedSkillReadSlugsForItem(entry, item) {
    var slugs = codexManagedSkillReadSlugsFromItem(item);
    var callId = codexItemCallId(item);
    if (entry) {
      entry.managedSkillBundleReadCalls = entry.managedSkillBundleReadCalls || {};
      if (slugs.length && callId.length) {
        entry.managedSkillBundleReadCalls[callId] = slugs.slice(0);
      } else if (!slugs.length && callId.length && entry.managedSkillBundleReadCalls[callId]) {
        slugs = entry.managedSkillBundleReadCalls[callId].slice(0);
      }
    }
    return slugs;
  }

  function recordCodexManagedSkillReads(entry, item, observedSlugs) {
    if (!entry || !entry.managedSkillBundle || entry.managedSkillBundle.refreshRequired !== true) {
      return;
    }
    var slugs = observedSlugs && observedSlugs.length
      ? observedSlugs.slice(0)
      : managedSkillReadSlugsForItem(entry, item);
    entry.managedSkillBundleReadSlugs = entry.managedSkillBundleReadSlugs || {};
    for (var i = 0; i < slugs.length; i++) {
      entry.managedSkillBundleReadSlugs[slugs[i]] = true;
    }
    var pending = entry.managedSkillBundle.pendingSlugs || [];
    for (var j = 0; j < pending.length; j++) {
      if (entry.managedSkillBundleReadSlugs[pending[j]] !== true) {
        return;
      }
    }
    if (acknowledgeManagedSkillBundle(entry.home && entry.home.path, entry.managedSkillBundle)) {
      entry.managedSkillBundle.acknowledgedFingerprint = entry.managedSkillBundle.fingerprint;
      entry.managedSkillBundle.acknowledgedAt = now();
      entry.managedSkillBundle.refreshRequired = false;
      entry.managedSkillBundle.pendingSlugs = [];
      pushEvent(entry, "guidance/acknowledged", {
        provider: "codex",
        fingerprint: entry.managedSkillBundle.fingerprint,
        skills: slugs
      });
    }
  }

  function handleCodexManagedSkillReadItem(entry, item, completed) {
    var slugs = managedSkillReadSlugsForItem(entry, item);
    if (!slugs.length) {
      return false;
    }
    if (completed === true) {
      recordCodexManagedSkillReads(entry, item, slugs);
      var callId = codexItemCallId(item);
      if (callId.length && entry && entry.managedSkillBundleReadCalls) {
        delete entry.managedSkillBundleReadCalls[callId];
      }
    }
    return true;
  }

  function baselineFreshCodexSkillBundle(entry) {
    var bundle = entry && entry.managedSkillBundle;
    if (!entry || entry.codexHasStartedTurn === true || !bundle || bundle.ready !== true ||
        trim(bundle.acknowledgedFingerprint).length || !trim(bundle.fingerprint).length) {
      return false;
    }
    if (!acknowledgeManagedSkillBundle(entry.home && entry.home.path, bundle)) {
      return false;
    }
    bundle.acknowledgedFingerprint = bundle.fingerprint;
    bundle.acknowledgedAt = now();
    bundle.refreshRequired = false;
    bundle.pendingSlugs = [];
    return true;
  }

  function codexToolNameFromPayload(payload) {
    payload = payload || {};
    return trim(payload.tool || payload.name || (payload.invocation && (payload.invocation.tool || payload.invocation.name)) || "");
  }

  function handleCodexEventMessage(entry, message) {
    var payload = message.payload || {};
    var payloadType = String(payload.type || "");
    if (payloadType === "task_started") {
      entry.status = "running";
      entry.phase = "turn";
      pushEvent(entry, "turn/start", { provider: "codex", threadId: entry.codexThreadId });
      return true;
    }
    if (payloadType === "agent_message") {
      var text = trim(payload.message || payload.text || codexContentText(payload.content));
      var phase = String(payload.phase || "");
      if (codexAgentMessageLooksFinal(text, phase)) {
        pushCodexAnswer(entry, text, "event_msg");
      } else {
        pushCodexProgress(entry, text, phase, "event_msg");
      }
      return true;
    }
    if (payloadType === "mcp_tool_call_end") {
      var status = payload.result && payload.result.Err ? "failed" : "completed";
      pushEvent(entry, "tool/update", {
        title: codexToolTitleFromInvocation(payload.invocation) || payload.call_id || "tool",
        toolName: codexToolNameFromPayload(payload),
        server: payload.invocation && payload.invocation.server ? payload.invocation.server : "",
        status: status,
        callId: payload.call_id || "",
        invocation: payload.invocation || {},
        result: payload.result || {},
        detail: codexToolPreview(payload.result),
        provider: "codex"
      });
      return true;
    }
    if (payloadType === "task_complete") {
      pushCodexTurnEnd(entry, {
        result: payload,
        provider: "codex",
        threadId: entry.codexThreadId
      });
      return true;
    }
    return false;
  }

  function handleCodexResponseItem(entry, message) {
    var payload = message.payload || {};
    var payloadType = String(payload.type || "");
    if (payloadType === "function_call" || payloadType === "tool_search_call") {
      if (handleCodexManagedSkillReadItem(entry, payload, false)) {
        return true;
      }
      pushEvent(entry, "tool/start", {
        title: codexToolTitleFromInvocation(payload) || payload.name || payloadType,
        toolName: codexToolNameFromPayload(payload),
        status: "running",
        callId: payload.call_id || "",
        arguments: payload.arguments || "",
        detail: codexToolPreview(payload.arguments),
        provider: "codex"
      });
      return true;
    }
    if (payloadType === "function_call_output" || payloadType === "tool_search_output") {
      if (handleCodexManagedSkillReadItem(entry, payload, true)) {
        return true;
      }
      pushEvent(entry, "tool/update", {
        title: payload.name || "",
        toolName: codexToolNameFromPayload(payload),
        status: "completed",
        callId: payload.call_id || "",
        output: payload.output || "",
        detail: codexToolPreview(payload.output),
        provider: "codex"
      });
      return true;
    }
    if (payloadType === "message" && String(payload.role || "") === "assistant") {
      var text = codexContentText(payload.content);
      var phase = String(payload.phase || "");
      if (phase === "final_answer") {
        pushCodexAnswer(entry, text, "response_item");
      } else if (phase === "commentary") {
        pushCodexProgress(entry, text, phase, "response_item");
      }
      return true;
    }
    return false;
  }

  function codexLineKey(text) {
    try {
      return String(new java.lang.String(String(text)).hashCode()) + ":" + String(text.length);
    } catch (_ignoreHash) {
      return String(text.length) + ":" + String(text).substring(0, 80);
    }
  }

  function markCodexLine(entry, text) {
    if (!entry || !text.length) {
      return false;
    }
    if (!entry.codexSeenLineKeys) {
      entry.codexSeenLineKeys = {};
      entry.codexSeenLineOrder = [];
    }
    var key = codexLineKey(text);
    if (entry.codexSeenLineKeys[key] === true) {
      return false;
    }
    entry.codexSeenLineKeys[key] = true;
    entry.codexSeenLineOrder.push(key);
    while (entry.codexSeenLineOrder.length > 12000) {
      var oldKey = entry.codexSeenLineOrder.shift();
      delete entry.codexSeenLineKeys[oldKey];
    }
    return true;
  }

  function rememberCodexSession(entry, rawId, source) {
    var id = trim(rawId);
    if (!entry || !id.length) {
      return false;
    }
    var currentSessionId = trim(entry.sessionId);
    var currentThreadId = trim(entry.codexThreadId);
    if (!currentSessionId.length || currentSessionId === id) {
      entry.sessionId = id;
      currentSessionId = id;
    }
    if (!currentThreadId.length || currentThreadId === id) {
      entry.codexThreadId = id;
      currentThreadId = id;
    }
    if (!currentSessionId.length && currentThreadId.length) {
      entry.sessionId = currentThreadId;
      currentSessionId = currentThreadId;
    }
    if (!currentThreadId.length && currentSessionId.length) {
      entry.codexThreadId = currentSessionId;
      currentThreadId = currentSessionId;
    }
    pushEvent(entry, "session/update", {
      sessionId: currentSessionId,
      threadId: currentThreadId,
      reportedSessionId: id,
      provider: "codex",
      source: source || ""
    });
    return true;
  }

  function handleCodexLine(entry, line, streamName) {
    var text = trim(line);
    if (!text.length) {
      return;
    }
    if (!markCodexLine(entry, text)) {
      return;
    }
    if (streamName !== "stdout" && streamName !== "codex-session") {
      if (streamName === "stderr") {
        entry.lastError = text;
      }
      pushEvent(entry, streamName, { line: text });
      return;
    }

    var message;
    try {
      message = JSON.parse(text);
    } catch (_ignoreCodexJson) {
      pushEvent(entry, "diagnostic", { line: text });
      return;
    }

    var type = String(message.type || "");
    if (type === "session_meta") {
      var metaPayload = message.payload || {};
      rememberCodexSession(entry, metaPayload.id || metaPayload.session_id || metaPayload.sessionId || metaPayload.thread_id || metaPayload.threadId || message.id, "session_meta");
      return;
    }
    if (type === "event_msg" && handleCodexEventMessage(entry, message)) {
      return;
    }
    if (type === "response_item" && handleCodexResponseItem(entry, message)) {
      return;
    }
    if (type === "thread.started") {
      rememberCodexSession(entry, message.thread_id || message.threadId, "thread.started");
      return;
    }
    if (type === "turn.started") {
      entry.status = "running";
      entry.phase = "turn";
      pushEvent(entry, "turn/start", { provider: "codex", threadId: entry.codexThreadId });
      return;
    }
    if (type === "item.started" || type === "item.updated" || type === "item.completed") {
      var item = message.item || {};
      var itemType = String(item.type || "").toLowerCase();
      var itemText = codexItemText(item);
      if (itemType === "agent_message") {
        if (itemText.length) {
          var itemPhase = String(item.phase || (item.metadata && item.metadata.phase) || "");
          if (codexAgentMessageLooksFinal(itemText, itemPhase)) {
            pushCodexAnswer(entry, itemText, "item");
          } else {
            pushCodexProgress(entry, itemText, itemPhase || "commentary", "item");
          }
        }
        return;
      }
      if (isCodexReasoningItem(itemType)) {
        if (itemText.length) {
          pushEvent(entry, "reasoning/chunk", {
            text: itemText,
            item: item,
            provider: "codex"
          });
        } else {
          pushEvent(entry, "codex/item", { eventType: type, item: item });
        }
        return;
      }
      if (isCodexToolItem(itemType)) {
        if (handleCodexManagedSkillReadItem(entry, item, type === "item.completed")) {
          return;
        }
        pushEvent(entry, type === "item.started" ? "tool/start" : "tool/update", {
          title: codexItemTitle(item),
          toolName: codexToolNameFromPayload(item),
          status: type === "item.completed" ? "completed" : "running",
          callId: item.call_id || item.callId || item.id || "",
          item: item,
          detail: codexToolPreview(item.output || item.result || item.content || item.arguments),
          provider: "codex"
        });
        return;
      }
      pushEvent(entry, "codex/item", { eventType: type, item: item });
      return;
    }
    if (type === "turn.completed") {
      if (message.usage) {
        pushEvent(entry, "usage/update", {
          usage: message.usage,
          provider: "codex"
        });
      }
      pushCodexTurnEnd(entry, {
        result: message,
        provider: "codex",
        threadId: entry.codexThreadId
      });
      return;
    }
    if (type === "turn.failed" || type === "error") {
      entry.status = "error";
      entry.phase = "error";
      entry.lastError = JSON.stringify(message);
      pushEvent(entry, "turn/error", {
        error: message,
        provider: "codex"
      });
      return;
    }

    pushEvent(entry, "codex/event", { event: message });
  }

  function codexSessionDatePath(timeMillis) {
    try {
      return String(new java.text.SimpleDateFormat("yyyy/MM/dd").format(new java.util.Date(timeMillis || now())));
    } catch (_ignoreDateFormat) {
      return "";
    }
  }

  function codexSessionRoots(entry) {
    var roots = [];
    var addRoot = function (path) {
      path = trim(path);
      if (!path.length) {
        return;
      }
      for (var i = 0; i < roots.length; i++) {
        if (roots[i] === path) {
          return;
        }
      }
      roots.push(path);
    };
    if (entry && entry.home && entry.home.path) {
      addRoot(entry.home.path);
    }
    addRoot(childPath(String(System.getProperty("user.home")), ".codex"));
    return roots;
  }

  function sessionFileLooksLikeEntry(file, entry) {
    try {
      var text = readTextFile(file);
      if (entry && trim(entry.sessionId || entry.codexThreadId).length && text.indexOf(trim(entry.sessionId || entry.codexThreadId)) !== -1) {
        return true;
      }
      if (entry.handle && text.indexOf(entry.handle) !== -1) {
        return true;
      }
      if (entry.cwd && text.indexOf("\"cwd\":\"" + String(entry.cwd).replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + "\"") !== -1) {
        return true;
      }
    } catch (_ignoreSessionProbe) {}
    return false;
  }

  function completeLineCount(file) {
    var text = readTextFile(file);
    if (!text.length) {
      return 0;
    }
    var lines = text.split(/\r?\n/);
    var completeLines = lines.length;
    if (text.charAt(text.length - 1) !== "\n") {
      completeLines--;
    }
    return completeLines < 0 ? 0 : completeLines;
  }

  function findCodexSessionFileById(entry) {
    var sessionId = trim(entry && (entry.sessionId || entry.codexThreadId));
    if (!sessionId.length) {
      return null;
    }
    var best = null;
    var bestModified = 0;
    var roots = codexSessionRoots(entry);
    for (var r = 0; r < roots.length; r++) {
      var sessions = new File(roots[r], "sessions");
      var stack = sessions.exists() ? [sessions] : [];
      while (stack.length) {
        var dir = stack.pop();
        var files = dir.listFiles();
        if (files === null) {
          continue;
        }
        for (var i = 0; i < files.length; i++) {
          var file = files[i];
          if (file.isDirectory()) {
            stack.push(file);
            continue;
          }
          if (!file.isFile() || String(file.getName()).indexOf(".jsonl") === -1) {
            continue;
          }
          if (String(file.getName()).indexOf(sessionId) === -1) {
            continue;
          }
          var modified = Number(file.lastModified() || 0);
          if (modified >= bestModified) {
            best = file;
            bestModified = modified;
          }
        }
      }
    }
    return best;
  }

  function findCodexSessionFile(entry) {
    var best = null;
    var bestModified = 0;
    var datePath = codexSessionDatePath(entry.codexSessionWatchStartedAt || entry.createdAt || now());
    var roots = codexSessionRoots(entry);
    var minModified = Number(entry.codexSessionWatchStartedAt || entry.createdAt || now()) - 60000;
    for (var r = 0; r < roots.length; r++) {
      var dir = new File(new File(roots[r], "sessions"), datePath);
      var files = dir.exists() ? dir.listFiles() : null;
      if (files === null) {
        continue;
      }
      for (var i = 0; i < files.length; i++) {
        var file = files[i];
        if (!file.isFile() || String(file.getName()).indexOf(".jsonl") === -1) {
          continue;
        }
        var modified = Number(file.lastModified() || 0);
        if (modified < minModified || modified < bestModified) {
          continue;
        }
        if (sessionFileLooksLikeEntry(file, entry)) {
          best = file;
          bestModified = modified;
        }
      }
    }
    return best;
  }

  function pollCodexSessionFile(entry) {
    if (!entry || entry.protocol !== "codex-jsonl") {
      return;
    }
    var file = trim(entry.codexSessionFile).length ? new File(entry.codexSessionFile) : null;
    if (file === null || !file.exists()) {
      file = findCodexSessionFile(entry);
      if (file === null) {
        return;
      }
      entry.codexSessionFile = filePath(file);
      entry.codexSessionFileLineCount = 0;
      pushEvent(entry, "session/update", {
        sessionFile: entry.codexSessionFile,
        provider: "codex"
      });
    }
    var text = readTextFile(file);
    if (!text.length) {
      return;
    }
    var lines = text.split(/\r?\n/);
    var completeLines = lines.length;
    if (text.charAt(text.length - 1) !== "\n") {
      completeLines--;
    }
    if (entry.codexSessionFileLineCount > completeLines) {
      entry.codexSessionFileLineCount = 0;
    }
    for (var i = entry.codexSessionFileLineCount; i < completeLines; i++) {
      handleCodexLine(entry, lines[i], "codex-session");
    }
    entry.codexSessionFileLineCount = completeLines;
  }

  function startCodexSessionWatcher(entry) {
    if (!entry || entry.protocol !== "codex-jsonl") {
      return;
    }
    if (entry.codexSessionWatcherThread !== null) {
      try {
        if (entry.codexSessionWatcherThread.isAlive()) {
          return;
        }
      } catch (_ignoreWatcherAlive) {}
      entry.codexSessionWatcherThread = null;
    }
    entry.codexSessionWatchStartedAt = now();
    var thread = new Thread(new Runnable({
      run: function () {
        var pollsAfterExit = 0;
        while (entry.status !== "closed") {
          try {
            pollCodexSessionFile(entry);
          } catch (e) {
            entry.lastError = String(e);
            pushEvent(entry, "error", { message: String(e), phase: "codex_session_watcher" });
          }
          if (!processAlive(entry.process)) {
            pollsAfterExit++;
            if (pollsAfterExit > 6) {
              break;
            }
          }
          try {
            Thread.sleep(500);
          } catch (_ignoreWatcherSleep) {
            break;
          }
        }
      }
    }), "lib_ConvertigoAgentBridge-codex-session-" + entry.handle);
    thread.setDaemon(true);
    thread.start();
    entry.codexSessionWatcherThread = thread;
  }

  function prepareCodexSessionWatcherForPrompt(entry) {
    if (!entry || entry.protocol !== "codex-jsonl") {
      return;
    }
    entry.codexSeenLineKeys = {};
    entry.codexSeenLineOrder = [];
    entry.codexSessionWatchStartedAt = now();
    entry.codexSessionFile = "";
    entry.codexSessionFileLineCount = 0;
    var file = findCodexSessionFileById(entry);
    if (file !== null) {
      entry.codexSessionFile = filePath(file);
      entry.codexSessionFileLineCount = completeLineCount(file);
      pushEvent(entry, "session/update", {
        sessionFile: entry.codexSessionFile,
        baselineLineCount: entry.codexSessionFileLineCount,
        provider: "codex"
      });
    }
  }

  function codexRuntimeMode(options) {
    var mode = trim(options.codexRuntimeMode || options.codexProtocol || options.runtimeMode || options.protocol).toLowerCase();
    if (!mode.length || mode === "server" || mode === "stdio" || mode === "stdio://" || mode === "appserver" || mode === "app-server") {
      return "app-server";
    }
    if (mode === "exec" || mode === "jsonl" || mode === "codex-jsonl") {
      return "exec";
    }
    return mode;
  }

  function codexAppServerCommand(baseCommand, options) {
    var command = parseCommand(options.appServerCommand || options.codexAppServerCommand, [baseCommand || "codex"]);
    if (command.length === 1) {
      command.push("app-server");
      command.push("--listen");
      command.push("stdio://");
    }
    return command;
  }

  function codexApprovalPolicy(options) {
    var explicit = trim(options.approvalPolicy || options.askForApproval);
    if (explicit.length) {
      return explicit;
    }
    return boolValue(options.bypassApprovalsAndSandbox, true) ? "never" : "on-request";
  }

  function codexSandboxMode(options) {
    var sandbox = trim(options.sandbox || options.sandboxMode);
    if (sandbox.length) {
      return sandbox;
    }
    return boolValue(options.bypassApprovalsAndSandbox, true) ? "danger-full-access" : "workspace-write";
  }

  function codexThreadParams(entry, options) {
    var params = {
      cwd: entry.cwd,
      approvalPolicy: codexApprovalPolicy(options),
      approvalsReviewer: "user",
      sandbox: codexSandboxMode(options),
      threadSource: "user"
    };
    if (trim(entry.model || options.model || options.agentModel).length) {
      params.model = trim(entry.model || options.model || options.agentModel);
    }
    if (trim(entry.serviceTier || options.serviceTier || options.speedTier).length) {
      params.serviceTier = trim(entry.serviceTier || options.serviceTier || options.speedTier);
    }
    return params;
  }

  function codexTurnParams(entry, options, promptText, requestId) {
    var params = {
      threadId: entry.codexThreadId || entry.sessionId,
      clientUserMessageId: trim(options.messageId) || ("bridge-" + requestId),
      input: [{
        type: "text",
        text: promptText,
        text_elements: []
      }],
      cwd: entry.cwd,
      approvalPolicy: codexApprovalPolicy(options)
    };
    if (trim(entry.model || options.model || options.agentModel).length) {
      params.model = trim(entry.model || options.model || options.agentModel);
    }
    if (trim(entry.serviceTier || options.serviceTier || options.speedTier).length) {
      params.serviceTier = trim(entry.serviceTier || options.serviceTier || options.speedTier);
    }
    if (trim(entry.reasoningEffort || options.reasoningEffort || options.reasoningLevel || options.modelReasoningEffort).length) {
      params.effort = normalizeCodexReasoningEffort(entry.reasoningEffort || options.reasoningEffort || options.reasoningLevel || options.modelReasoningEffort);
    }
    return params;
  }

  function codexRestartThreadId(entry) {
    if (!entry || entry.codexHasStartedTurn !== true) {
      return "";
    }
    return trim(entry.codexThreadId || entry.sessionId);
  }

  function codexMcpStartupStatus(params) {
    params = params || {};
    return {
      name: trim(params.name),
      status: trim(params.status).toLowerCase(),
      error: params.error || null,
      failureReason: params.failureReason || null,
      updatedAt: now()
    };
  }

  function recordCodexMcpStartupStatus(entry, params) {
    var startup = codexMcpStartupStatus(params);
    if (!entry.codexMcpStartupStatuses) {
      entry.codexMcpStartupStatuses = {};
    }
    if (startup.name.length) {
      entry.codexMcpStartupStatuses[startup.name.toLowerCase()] = startup;
    }
    return startup;
  }

  function waitForCodexMcpReady(entry, serverName, timeoutMs) {
    var name = trim(serverName);
    if (!name.length) {
      return null;
    }
    var key = name.toLowerCase();
    var deadline = now() + timeoutMs;
    while (now() < deadline) {
      var startup = entry.codexMcpStartupStatuses && entry.codexMcpStartupStatuses[key];
      if (startup && startup.status === "ready") {
        return startup;
      }
      if (startup && (startup.status === "failed" || startup.status === "error")) {
        var detail = startup.failureReason || startup.error;
        if (detail && typeof detail !== "string") {
          try { detail = JSON.stringify(detail); } catch (_ignoreMcpStartupDetail) { detail = String(detail); }
        }
        throw new Error("Codex MCP server " + name + " failed to start" + (trim(detail).length ? ": " + trim(detail) : ""));
      }
      if (!processAlive(entry.process)) {
        throw new Error("Codex process exited while waiting for MCP server " + name);
      }
      Thread.sleep(50);
    }
    throw new Error("Timeout while waiting for Codex MCP server " + name + " to become ready");
  }

  function sendCodexAppServerRequest(entry, method, params) {
    var id = entry.nextRequestId++;
    var pending = {
      id: id,
      method: method,
      startedAt: now(),
      done: false,
      response: null,
      completedAt: 0
    };
    entry.pending.put(String(id), pending);
    writeJson(entry, {
      id: id,
      method: method,
      params: params || {}
    });
    pushEvent(entry, "codex/request", {
      id: id,
      method: method,
      provider: "codex"
    });
    return pending;
  }

  function codexAppServerRequest(entry, method, params, timeoutMs) {
    var pending = sendCodexAppServerRequest(entry, method, params);
    return waitForPending(entry, pending, timeoutMs || 60000, true);
  }

  function codexAppServerThreadFromResponse(response) {
    response = response || {};
    return response.thread || (response.result && response.result.thread) || {};
  }

  function startCodexAppServer(entry, env, options, setup) {
    var timeoutMs = intValue(options.requestTimeoutMs || options.appServerTimeoutMs, 60000, 1000, 180000);
    entry.command = codexAppServerCommand(entry.codexPath || "codex", options);
    entry.envKeys = envKeys(env);
    startProcess(entry, env);
    pushEvent(entry, "system/start", {
      handle: entry.handle,
      provider: "codex",
      protocol: "codex-app-server",
      command: entry.command,
      cwd: entry.cwd,
      codexHome: setup.setup.codexHome,
      home: publicHomeInfo(setup.setup.home),
      resumedThreadId: entry.codexThreadId,
      mcp: setup.setup.mcp,
      reasoningEffort: entry.reasoningEffort,
      serviceTier: entry.serviceTier
    });

    entry.phase = "initialize";
    entry.init = codexAppServerRequest(entry, "initialize", {
      clientInfo: {
        name: "lib_ConvertigoAgentBridge",
        version: "0.1.0"
      },
      capabilities: null
    }, timeoutMs);
    writeJson(entry, { method: "initialized" });

    var threadResponse;
    if (entry.sessionId.length || entry.codexThreadId.length) {
      entry.phase = "thread/resume";
      var resumeParams = codexThreadParams(entry, options);
      resumeParams.threadId = entry.sessionId || entry.codexThreadId;
      threadResponse = codexAppServerRequest(entry, "thread/resume", resumeParams, timeoutMs);
    } else {
      entry.phase = "thread/start";
      threadResponse = codexAppServerRequest(entry, "thread/start", codexThreadParams(entry, options), timeoutMs);
    }

    var thread = codexAppServerThreadFromResponse(threadResponse);
    rememberCodexSession(entry, thread.id || thread.threadId || entry.sessionId || entry.codexThreadId, "app-server");
    var managedMcpServerName = trim(setup.setup && setup.setup.mcp && setup.setup.mcp.managedServerName);
    if (managedMcpServerName.length) {
      entry.phase = "mcp/startup";
      entry.managedMcpStartup = waitForCodexMcpReady(
        entry,
        managedMcpServerName,
        intValue(options.mcpStartupTimeoutMs, 30000, 1000, 180000)
      );
    }
    entry.phase = "ready";
    entry.status = "running";
    entry.session = threadResponse;
    rememberSessionHandle(entry.handle);
  }

  function codexAppServerItemTitle(item) {
    item = item || {};
    if (item.type === "commandExecution") {
      return item.command || "command";
    }
    if (item.type === "mcpToolCall") {
      return trim(item.server).length || trim(item.tool).length ? trim(item.server) + "." + trim(item.tool) : "mcp tool";
    }
    if (item.type === "dynamicToolCall") {
      return trim(item.namespace).length ? trim(item.namespace) + "." + trim(item.tool) : trim(item.tool) || "tool";
    }
    if (item.type === "fileChange") {
      return "file change";
    }
    if (item.type === "webSearch") {
      return "web search";
    }
    return item.type || "item";
  }

  function codexAppServerToolStatus(item, completed) {
    if (completed) {
      return "completed";
    }
    var status = trim(item && item.status);
    return status.length ? status : "running";
  }

  function codexAppServerToolDetail(item) {
    item = item || {};
    return codexToolPreview(item.aggregatedOutput || item.result || item.error || item.arguments || item.changes || item.query || "");
  }

  function codexAppServerDeltaPhase(entry, itemId) {
    var item = entry && entry.codexAppServerItems ? entry.codexAppServerItems[itemId] : null;
    return String((item && item.phase) || "").toLowerCase();
  }

  function codexAppServerShouldFlushText(text) {
    var value = String(text || "");
    if (!trim(value).length) {
      return false;
    }
    if (/[\r\n]/.test(value)) {
      return true;
    }
    if (/[.!?;:]\s*$/.test(value) && trim(value).length >= 24) {
      return true;
    }
    return value.length >= 140 && /\s$/.test(value);
  }

  function codexAppServerAppendStoredDelta(entry, itemId, delta) {
    itemId = String(itemId || "");
    delta = String(delta || "");
    if (!delta.length) {
      return;
    }
    if (!entry.codexAppServerDeltaText) {
      entry.codexAppServerDeltaText = {};
    }
    entry.codexAppServerDeltaText[itemId] = String(entry.codexAppServerDeltaText[itemId] || "") + delta;
  }

  function codexAppServerAppendDelta(entry, itemId, delta) {
    itemId = String(itemId || "");
    delta = String(delta || "");
    if (!delta.length) {
      return;
    }
    codexAppServerAppendStoredDelta(entry, itemId, delta);
    if (!entry.codexAppServerDeltaPending) {
      entry.codexAppServerDeltaPending = {};
    }
    entry.codexAppServerDeltaPending[itemId] = String(entry.codexAppServerDeltaPending[itemId] || "") + delta;
  }

  function codexAppServerAppendReasoningSummary(entry, itemId, delta) {
    itemId = String(itemId || "");
    delta = String(delta || "");
    if (!delta.length) {
      return;
    }
    codexAppServerAppendStoredDelta(entry, itemId, delta);
    if (!entry.codexAppServerReasoningSummaryPending) {
      entry.codexAppServerReasoningSummaryPending = {};
    }
    entry.codexAppServerReasoningSummaryPending[itemId] = String(entry.codexAppServerReasoningSummaryPending[itemId] || "") + delta;
  }

  function codexAppServerFlushPendingAgentMessage(entry, itemId, phase, force) {
    itemId = String(itemId || "");
    if (!entry.codexAppServerDeltaPending) {
      return false;
    }
    var pending = String(entry.codexAppServerDeltaPending[itemId] || "");
    if (!trim(pending).length) {
      return false;
    }
    if (force !== true && !codexAppServerShouldFlushText(pending)) {
      return false;
    }
    entry.codexAppServerDeltaPending[itemId] = "";
    if (!entry.codexAppServerStreamedItems) {
      entry.codexAppServerStreamedItems = {};
    }
    entry.codexAppServerStreamedItems[itemId] = true;
    if (String(phase || "").toLowerCase() === "final_answer") {
      pushCodexRawChunk(entry, pending, "final_answer", "app-server-delta");
      pushCodexProgress(entry, pending, "final_answer", "app-server-delta");
    } else {
      pushCodexProgressChunk(entry, pending, phase || "commentary", "app-server-delta");
    }
    return true;
  }

  function codexAppServerFlushReasoningSummary(entry, itemId, force) {
    itemId = String(itemId || "");
    if (!entry.codexAppServerReasoningSummaryPending) {
      return false;
    }
    var pending = String(entry.codexAppServerReasoningSummaryPending[itemId] || "");
    if (!trim(pending).length) {
      return false;
    }
    if (force !== true && !codexAppServerShouldFlushText(pending)) {
      return false;
    }
    entry.codexAppServerReasoningSummaryPending[itemId] = "";
    pushCodexProgressChunk(entry, pending, "reasoning_summary", "app-server-delta");
    return true;
  }

  function codexAppServerHandleItem(entry, item, completed) {
    item = item || {};
    var type = String(item.type || "");
    if (!entry.codexAppServerItems) {
      entry.codexAppServerItems = {};
    }
    if (!entry.codexAppServerCompletedItems) {
      entry.codexAppServerCompletedItems = {};
    }
    if (item.id) {
      entry.codexAppServerItems[item.id] = item;
      if (completed && entry.codexAppServerCompletedItems[item.id] === true) {
        return true;
      }
    }
    if (type === "agentMessage") {
      if (!completed && item.id) {
        var runningPhase = String(item.phase || "").toLowerCase();
        if (runningPhase === "final_answer") {
          codexAppServerFlushPendingAgentMessage(entry, item.id, "final_answer", true);
        } else if (runningPhase === "commentary") {
          codexAppServerFlushPendingAgentMessage(entry, item.id, "commentary", false);
        }
        return true;
      }
      if (completed && item.id && entry.codexAppServerStreamedItems && entry.codexAppServerStreamedItems[item.id] === true) {
        codexAppServerFlushPendingAgentMessage(entry, item.id, item.phase, true);
        entry.codexAppServerCompletedItems[item.id] = true;
        return true;
      }
      var messageText = item.text || "";
      if (!trim(messageText).length && item.id && entry.codexAppServerDeltaText) {
        messageText = entry.codexAppServerDeltaText[item.id] || "";
      }
      if (completed && trim(messageText).length) {
        if (String(item.phase || "") === "commentary") {
          pushCodexProgress(entry, messageText, item.phase, "app-server-item");
        } else {
          pushCodexAnswer(entry, messageText, "app-server-item");
        }
      }
      if (completed && item.id) {
        entry.codexAppServerCompletedItems[item.id] = true;
      }
      return true;
    }
    if (type === "plan") {
      var planText = item.text || "";
      if (!trim(planText).length && item.id && entry.codexAppServerDeltaText) {
        planText = entry.codexAppServerDeltaText[item.id] || "";
      }
      if (trim(planText).length) {
        pushEvent(entry, "plan/update", {
          text: planText,
          item: item,
          provider: "codex"
        });
      }
      if (completed && item.id) {
        entry.codexAppServerCompletedItems[item.id] = true;
      }
      return true;
    }
    if (type === "reasoning") {
      if (completed && item.id) {
        codexAppServerFlushReasoningSummary(entry, item.id, true);
      }
      var text = "";
      if (item.summary && item.summary.length) {
        text = item.summary.join("\n");
      } else if (item.content && item.content.length) {
        text = item.content.join("\n");
      } else if (item.id && entry.codexAppServerDeltaText) {
        text = entry.codexAppServerDeltaText[item.id] || "";
      }
      if (trim(text).length) {
        pushEvent(entry, "reasoning/chunk", {
          text: text,
          item: item,
          provider: "codex"
        });
      }
      if (completed && item.id) {
        entry.codexAppServerCompletedItems[item.id] = true;
      }
      return true;
    }
    if (type === "commandExecution" || type === "mcpToolCall" || type === "dynamicToolCall" || type === "fileChange" || type === "webSearch") {
      pushEvent(entry, completed ? "tool/update" : "tool/start", {
        title: codexAppServerItemTitle(item),
        toolName: item.tool || item.command || type,
        status: codexAppServerToolStatus(item, completed),
        callId: item.id || "",
        item: item,
        detail: codexAppServerToolDetail(item),
        provider: "codex"
      });
      if (completed && item.id) {
        entry.codexAppServerCompletedItems[item.id] = true;
      }
      return true;
    }
    return false;
  }

  function handleCodexAppServerRequest(entry, message) {
    var method = String(message.method || "");
    var params = message.params || {};
    pushEvent(entry, "codex/request_from_server", {
      id: message.id || null,
      method: method,
      params: params,
      provider: "codex"
    });
    if (method === "item/commandExecution/requestApproval") {
      sendJsonResponse(entry, message.id, { decision: "accept" });
      return true;
    }
    if (method === "item/fileChange/requestApproval") {
      sendJsonResponse(entry, message.id, { decision: "accept" });
      return true;
    }
    if (method === "item/permissions/requestApproval") {
      sendJsonResponse(entry, message.id, {
        permissions: params.permissions || {},
        scope: "session"
      });
      return true;
    }
    sendJsonError(entry, message.id, -32601, "Unsupported Codex app-server request: " + method);
    return true;
  }

  function handleCodexAppServerLine(entry, line, streamName) {
    var text = trim(line);
    if (!text.length) {
      return;
    }
    if (streamName !== "stdout") {
      if (streamName === "stderr") {
        entry.lastError = text;
      }
      pushEvent(entry, streamName, { line: text, provider: "codex" });
      return;
    }

    var message;
    try {
      message = JSON.parse(text);
    } catch (_ignoreCodexAppServerJson) {
      pushEvent(entry, "diagnostic", { line: text, provider: "codex" });
      return;
    }

    if (typeof message.id !== "undefined" && (typeof message.result !== "undefined" || typeof message.error !== "undefined")) {
      var pending = entry.pending.get(String(message.id));
      if (pending !== null && typeof pending !== "undefined") {
        pending.response = message;
        pending.done = true;
        pending.completedAt = now();
        if (message.error) {
          entry.lastError = JSON.stringify(message.error);
          pushEvent(entry, "turn/error", {
            requestId: message.id,
            method: pending.method,
            error: message.error,
            provider: "codex"
          });
        } else if (pending.method === "turn/start") {
          var turn = (message.result && message.result.turn) || {};
          entry.activeTurnId = turn.id || entry.activeTurnId || "";
        }
      }
      pushEvent(entry, message.error ? "codex/response_error" : "codex/response", {
        id: message.id,
        method: pending ? pending.method : "",
        response: message,
        provider: "codex"
      });
      return;
    }

    var method = String(message.method || "");
    var params = message.params || {};
    if (!method.length) {
      pushEvent(entry, "codex/event", { event: message, provider: "codex" });
      return;
    }
    if (typeof message.id !== "undefined") {
      handleCodexAppServerRequest(entry, message);
      return;
    }
    if (method === "thread/started") {
      var thread = params.thread || {};
      rememberCodexSession(entry, params.threadId || thread.id || thread.threadId, "thread/started");
      return;
    }
    if (method === "thread/status/changed") {
      pushEvent(entry, "codex/thread_status", {
        threadId: params.threadId || entry.codexThreadId,
        status: params.status || {},
        provider: "codex"
      });
      return;
    }
    if (method === "thread/closed") {
      pushEvent(entry, "codex/thread_closed", {
        threadId: params.threadId || entry.codexThreadId,
        provider: "codex"
      });
      return;
    }
    if (method === "mcpServer/startupStatus/updated") {
      recordCodexMcpStartupStatus(entry, params);
      pushEvent(entry, "codex/event", {
        method: method,
        params: params,
        provider: "codex"
      });
      return;
    }
    if (method === "turn/started") {
      var startedTurn = params.turn || {};
      entry.activeTurnId = startedTurn.id || entry.activeTurnId || "";
      entry.status = "running";
      entry.phase = "turn";
      pushEvent(entry, "turn/start", {
        provider: "codex",
        threadId: params.threadId || entry.codexThreadId,
        turnId: entry.activeTurnId,
        turn: startedTurn
      });
      return;
    }
    if (method === "turn/completed") {
      var completedTurn = params.turn || {};
      entry.activeTurnId = completedTurn.id || entry.activeTurnId || "";
      if (completedTurn.items && completedTurn.items.length) {
        for (var i = 0; i < completedTurn.items.length; i++) {
          codexAppServerHandleItem(entry, completedTurn.items[i], true);
        }
      }
      pushCodexTurnEnd(entry, {
        result: params,
        provider: "codex",
        threadId: params.threadId || entry.codexThreadId,
        turnId: entry.activeTurnId
      });
      return;
    }
    if (method === "item/agentMessage/delta") {
      if (!entry.codexAppServerItemDeltas) {
        entry.codexAppServerItemDeltas = {};
      }
      entry.codexAppServerItemDeltas[params.itemId || ""] = true;
      var deltaItemId = params.itemId || "";
      var deltaPhase = codexAppServerDeltaPhase(entry, deltaItemId);
      codexAppServerAppendDelta(entry, deltaItemId, params.delta || "");
      if (deltaPhase === "final_answer") {
        codexAppServerFlushPendingAgentMessage(entry, deltaItemId, "final_answer", false);
      } else if (deltaPhase === "commentary") {
        codexAppServerFlushPendingAgentMessage(entry, deltaItemId, "commentary", false);
      }
      return;
    }
    if (method === "item/plan/delta") {
      codexAppServerAppendDelta(entry, params.itemId || "", params.delta || "");
      return;
    }
    if (method === "item/reasoning/textDelta" || method === "item/reasoning/summaryTextDelta") {
      var reasoningItemId = params.itemId || "";
      if (method === "item/reasoning/textDelta") {
        codexAppServerAppendStoredDelta(entry, reasoningItemId, params.delta || "");
      } else {
        codexAppServerAppendReasoningSummary(entry, reasoningItemId, params.delta || "");
      }
      if (method === "item/reasoning/summaryTextDelta") {
        codexAppServerFlushReasoningSummary(entry, reasoningItemId, false);
      }
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      if (!codexAppServerHandleItem(entry, params.item || {}, method === "item/completed")) {
        pushEvent(entry, "codex/item", {
          method: method,
          params: params,
          provider: "codex"
        });
      }
      return;
    }
    if (method === "error") {
      entry.status = "error";
      entry.phase = "error";
      entry.lastError = JSON.stringify(params);
      pushEvent(entry, "turn/error", {
        error: params,
        provider: "codex"
      });
      return;
    }
    pushEvent(entry, "codex/event", {
      method: method,
      params: params,
      provider: "codex"
    });
  }

  var CODEX_LOGIN_REGISTRY_KEY = "lib_ConvertigoAgentBridge.codexLoginRegistry.v1";

  function codexLoginRegistry() {
    var store = getServerStore();
    if (store !== null) {
      var registry = store.get(CODEX_LOGIN_REGISTRY_KEY);
      if (registry === null || typeof registry === "undefined") {
        registry = new ConcurrentHashMap();
        store.set(CODEX_LOGIN_REGISTRY_KEY, registry);
      }
      return registry;
    }
    if (!C8O.agentBridge._fallbackCodexLoginRegistry) {
      C8O.agentBridge._fallbackCodexLoginRegistry = new ConcurrentHashMap();
    }
    return C8O.agentBridge._fallbackCodexLoginRegistry;
  }

  function codexLoginOptions(options) {
    options = optionsWithRequestFallbacks(options || {});
    var copy = {};
    for (var key in options) {
      if (Object.prototype.hasOwnProperty.call(options, key)) {
        copy[key] = options[key];
      }
    }
    copy.codexHome = "";
    copy.agentHome = "";
    copy.codexHomeScope = "user";
    copy.homeScope = "user";
    copy.userId = trim(options.userId) || contextUserId() || "studio";
    return copy;
  }

  function codexLoginKey(homePath) {
    return "codex-login:" + filePath(new File(homePath));
  }

  function codexLoginOutput(entry) {
    var output = "";
    try { output += readTextFile(entry.stdoutFile); } catch (_ignoreLoginOut) {}
    try { output += "\n" + readTextFile(entry.stderrFile); } catch (_ignoreLoginErr) {}
    output = output.replace(/(access_token|refresh_token|id_token)\s*[:=]\s*[^\s]+/gi, "$1=<redacted>");
    if (output.length > 8000) {
      output = "... " + output.substring(output.length - 8000);
    }
    return output;
  }

  function codexLoginUrl(output) {
    var match = String(output || "").match(/https:\/\/[^\s<>'\"]+/i);
    return match ? match[0].replace(/[),.;]+$/, "") : "";
  }

  function publicCodexLogin(entry) {
    var output = codexLoginOutput(entry);
    var alive = processAlive(entry.process);
    var exitCode = -1;
    if (!alive) {
      try { exitCode = Number(entry.process.exitValue()); } catch (_ignoreLoginExit) {}
    }
    var authentication = inspectCodexAuthentication(entry.home);
    var credentialsUpdated = authentication.configured === true && Number(authentication.updatedAt || 0) >= Number(entry.startedAt || 0);
    if (alive && credentialsUpdated) {
      try { entry.process.destroy(); } catch (_ignoreCompletedLoginDestroy) {}
      alive = false;
      exitCode = 0;
    }
    var authenticated = authentication.configured === true && (!alive || credentialsUpdated);
    return {
      ok: alive || authenticated,
      status: alive ? "waiting_for_login" : (authenticated ? "authenticated" : "error"),
      running: alive,
      authenticated: authenticated,
      home: entry.home,
      verificationUrl: codexLoginUrl(output),
      message: alive ? "Waiting for Codex browser authentication." : (authenticated ? "Codex authentication completed." : "Codex authentication did not complete."),
      error: !alive && !authenticated ? trim(output) : "",
      startedAt: Number(entry.startedAt || 0),
      timestamp: now()
    };
  }

  C8O.agentBridge.codexLoginStatus = function (options) {
    var loginOptions = codexLoginOptions(options);
    var setup = detectCodexRuntimePresence(loginOptions);
    if (!setup.codex || setup.codex.found !== true || !trim(setup.codexHome).length) {
      return { ok: false, status: "missing", error: "Managed Codex runtime is not available.", timestamp: now() };
    }
    var entry = codexLoginRegistry().get(codexLoginKey(setup.codexHome));
    if (entry === null || typeof entry === "undefined") {
      var authentication = inspectCodexAuthentication(setup.codexHome);
      return {
        ok: authentication.configured === true,
        status: authentication.configured === true ? "authenticated" : "login_required",
        running: false,
        authenticated: authentication.configured === true,
        authentication: authentication,
        timestamp: now()
      };
    }
    var status = publicCodexLogin(entry);
    if (status.authenticated === true) {
      bootstrapCodexHome(loginOptions, setup.codexHome, setup.mcpEndpoint);
      status.authentication = inspectCodexAuthentication(setup.codexHome);
    }
    return status;
  };

  C8O.agentBridge.codexLoginStart = function (options) {
    var loginOptions = codexLoginOptions(options);
    var setup = detectCodexRuntimePresence(loginOptions);
    if (!setup.codex || setup.codex.found !== true || !trim(setup.codexHome).length) {
      return { ok: false, status: "missing", error: "Managed Codex runtime is not available.", timestamp: now() };
    }
    var loginBootstrap = bootstrapCodexHome(loginOptions, setup.codexHome, setup.mcpEndpoint);
    var key = codexLoginKey(setup.codexHome);
    var registry = codexLoginRegistry();
    var existing = registry.get(key);
    if (existing !== null && typeof existing !== "undefined" && processAlive(existing.process)) {
      return publicCodexLogin(existing);
    }
    var authentication = verifiedCodexAuthentication(loginOptions, setup.codexHome, setup.codex.path, loginBootstrap.authenticationImported === true);
    if (authentication.configured === true && !boolValue(options && options.forceLogin, false)) {
      return {
        ok: true,
        status: "authenticated",
        running: false,
        authenticated: true,
        authentication: authentication,
        timestamp: now()
      };
    }
    runCommandCaptured([setup.codex.path, "logout"], {
      timeoutMs: 15000,
      env: codexRuntimeEnv(loginOptions, setup.codexHome)
    });
    var stdoutFile = File.createTempFile("c8o-codex-login-out-", ".log");
    var stderrFile = File.createTempFile("c8o-codex-login-err-", ".log");
    var pb = new ProcessBuilder(toJavaList([setup.codex.path, "login"]));
    applyEngineProxyEnvironment(pb.environment(), "https://auth.openai.com");
    envObjectToMap(pb.environment(), codexRuntimeEnv(loginOptions, setup.codexHome));
    pb.directory(new File(setup.workspaceRoot));
    pb.redirectOutput(stdoutFile);
    pb.redirectError(stderrFile);
    var entry = {
      process: pb.start(),
      home: setup.codexHome,
      stdoutFile: stdoutFile,
      stderrFile: stderrFile,
      startedAt: now()
    };
    registry.put(key, entry);
    return publicCodexLogin(entry);
  };

  C8O.agentBridge.codexSetup = function (options) {
    options = optionsWithRequestFallbacks(options || {});
    if (boolValue(options.loginStatus || options.codexLoginStatus, false)) {
      return C8O.agentBridge.codexLoginStatus(options);
    }
    if (boolValue(options.login || options.codexLogin, false)) {
      return C8O.agentBridge.codexLoginStart(options);
    }
    var install = boolValue(options.install || options.installCodex, false);
    var installation = {
      attempted: false,
      installed: false,
      reused: false,
      method: "",
      package: "",
      steps: []
    };
    var messages = [];
    var startupPresenceOnly = boolValue(options.startupPresenceOnly, false);
    if (!install && startupPresenceOnly) {
      var presenceStartedAt = now();
      var presenceSetup = detectCodexRuntimePresence(options);
      var presenceDetectedAt = now();
      var presenceBootstrap = {
        attempted: false,
        ok: true,
        home: "",
        copied: [],
        reused: [],
        generated: [],
        message: "",
        error: ""
      };
      if (presenceSetup.home.error) {
        messages.push(presenceSetup.home.error);
      }
      if (presenceSetup.codex && presenceSetup.codex.found === true &&
          presenceSetup.home.path.length && !presenceSetup.home.error.length) {
        presenceBootstrap = bootstrapCodexHome(options, presenceSetup.home.path, presenceSetup.mcpEndpoint);
        if (presenceBootstrap.message) {
          messages.push(presenceBootstrap.message);
        }
        if (presenceBootstrap.error) {
          messages.push(presenceBootstrap.error);
        }
      }
      var presenceBootstrappedAt = now();
      var presenceSkills = installAgentSkills(options, "codex", presenceSetup.codexHome || presenceSetup.home.path);
      var presenceSkillsInstalledAt = now();
      if (presenceSkills.message) {
        messages.push(presenceSkills.message);
      }
      if (presenceSkills.error) {
        messages.push(presenceSkills.error);
      }
      presenceSetup = detectCodexRuntimePresence(options);
      var presenceRedetectedAt = now();
      if (presenceSetup.playwright) {
        presenceSetup.playwright.found = presenceSetup.playwright.installed === true;
      }
      var presenceProfile = agentCapabilityProfile(options);
      var presenceMcpReady = presenceProfile.id === "nocode"
        ? presenceSetup.mcp.hasManagedServer === true
        : presenceSetup.mcp.hasLegacy === true && (!flowCapabilityAvailable() || presenceSetup.mcp.hasFlow === true);
      var presenceManagedCodex = presenceSetup.codex.found && commandPathStartsWith(presenceSetup.codex, presenceSetup.installDir);
      var presencePlaywrightRequired = presenceManagedCodex && !boolValue(options.skipCodexPlaywrightInstall || options.skipPlaywrightInstall, false);
      var presenceAuthentication = codexDoctorAuthentication(
        options,
        presenceSetup.codexHome || presenceSetup.home.path,
        presenceSetup.codex.path,
        false
      );
      var presenceAuthenticationCheckedAt = now();
      var presenceRuntimeReady = presenceSetup.codex.found && !presenceSetup.home.error.length &&
        presenceSkills.ok === true && presenceMcpReady &&
        (!presencePlaywrightRequired || presenceSetup.playwright.found === true);
      var presenceReady = presenceRuntimeReady && presenceAuthentication.configured === true;
      if (!presenceMcpReady) {
        messages.push("Codex MCP configuration is not ready in the scoped home.");
      }
      if (presenceRuntimeReady && !presenceReady) {
        messages.push("Codex authentication is required. Run codex login or configure OPENAI_API_KEY.");
      }
      return {
        ok: presenceReady,
        status: presenceReady ? "ready" : (presenceRuntimeReady ? "authentication_required" : "missing"),
        setup: presenceSetup,
        authentication: presenceAuthentication,
        installation: installation,
        bootstrap: presenceBootstrap,
        skills: presenceSkills,
        messages: messages,
        startupPresenceOnly: true,
        timings: {
          detectMs: presenceDetectedAt - presenceStartedAt,
          bootstrapMs: presenceBootstrappedAt - presenceDetectedAt,
          skillsMs: presenceSkillsInstalledAt - presenceBootstrappedAt,
          redetectMs: presenceRedetectedAt - presenceSkillsInstalledAt,
          authenticationMs: presenceAuthenticationCheckedAt - presenceRedetectedAt,
          totalMs: presenceAuthenticationCheckedAt - presenceStartedAt
        },
        timestamp: now()
      };
    }
    if (!install) {
      var preflightSetup = detectCodexRuntimePresence(options);
      if (preflightSetup.codex && preflightSetup.codex.found === true && trim(preflightSetup.codexHome).length) {
        var preflightBootstrap = bootstrapCodexHome(options, preflightSetup.codexHome, preflightSetup.mcpEndpoint);
        var preflightAuthentication = verifiedCodexAuthentication(options, preflightSetup.codexHome, preflightSetup.codex.path, preflightBootstrap.authenticationImported === true);
        if (preflightAuthentication.configured !== true) {
          return {
            ok: false,
            status: "authentication_required",
            setup: preflightSetup,
            authentication: preflightAuthentication,
            installation: installation,
            bootstrap: preflightBootstrap,
            skills: null,
            messages: ["Codex authentication is required. Sign in from the agent configuration."],
            timestamp: now()
          };
        }
      }
    }
    if (install) {
      try {
        installation = ensureCodexRuntime(options);
      } catch (e) {
        var failedSetup = detectCodexRuntime(options);
        messages.push(String(e));
        return {
          ok: false,
          status: "error",
          phase: "codex_setup",
          error: String(e),
          setup: failedSetup,
          installation: installation,
          messages: messages,
          timestamp: now()
        };
      }
    }
    var setup = detectCodexRuntime(options);
    var bootstrap = {
      attempted: false,
      ok: true,
      home: "",
      copied: [],
      reused: [],
      generated: [],
      message: "",
      error: ""
    };
    if (setup.home.error) {
      messages.push(setup.home.error);
    }
    if (setup.home.path.length && !setup.home.error.length) {
      bootstrap = bootstrapCodexHome(options, setup.home.path, setup.mcpEndpoint);
      if (bootstrap.message) {
        messages.push(bootstrap.message);
      }
      if (bootstrap.error) {
        messages.push(bootstrap.error);
      }
      setup = detectCodexRuntime(options);
    }
    var skills = installAgentSkills(options, "codex", setup.codexHome || setup.home.path);
    if (skills.message) {
      messages.push(skills.message);
    }
    if (skills.error) {
      messages.push(skills.error);
    }
    if (skills.ok === true) {
      setup = detectCodexRuntime(options);
    }
    var capabilityProfile = agentCapabilityProfile(options);
    var mcpReady = capabilityProfile.id === "nocode"
      ? setup.mcp.hasManagedServer === true
      : setup.mcp.hasLegacy === true && (!flowCapabilityAvailable() || setup.mcp.hasFlow === true);
    if (setup.codex.found && !mcpReady) {
      messages.push(capabilityProfile.id === "nocode"
        ? "Codex does not list the Convertigo NoCode MCP server after setup."
        : (flowCapabilityAvailable()
          ? "Codex does not list both Convertigo Legacy and Flow MCP servers after setup."
          : "Codex does not list the Convertigo MCP server after setup."));
    }
    var managedCodex = setup.codex.found && commandPathStartsWith(setup.codex, setup.installDir);
    var playwrightRequired = managedCodex && !boolValue(options.skipCodexPlaywrightInstall || options.skipPlaywrightInstall, false);
    if (playwrightRequired && (!setup.playwright || setup.playwright.found !== true)) {
      messages.push("Playwright MCP is not available in the managed Codex runtime.");
    }
    var authentication = verifiedCodexAuthentication(options, setup.codexHome || setup.home.path, setup.codex.path, bootstrap.authenticationImported === true);
    var runtimeReady = setup.codex.found && !setup.home.error.length && skills.ok === true && mcpReady && (!playwrightRequired || setup.playwright.found === true);
    var ready = runtimeReady && authentication.configured === true;
    if (runtimeReady && !ready) {
      messages.push("Codex authentication is required. Run codex login or configure OPENAI_API_KEY.");
    }
    return {
      ok: ready,
      status: ready ? "ready" : (runtimeReady ? "authentication_required" : "missing"),
      setup: setup,
      authentication: authentication,
      installation: installation,
      bootstrap: bootstrap,
      skills: skills,
      messages: messages,
      timestamp: now()
    };
  };

  function codexCredentials(options, home) {
    var scope = home && home.path ? "scoped-home" : "default-home";
    return {
      policy: scope,
      sources: [{
        source: scope,
        path: home && home.path ? home.path : childPath(String(System.getProperty("user.home")), ".codex"),
        exists: home && home.path ? new File(home.path).exists() : new File(childPath(String(System.getProperty("user.home")), ".codex")).exists(),
        keys: [],
        injectedKeys: []
      }],
      injectedKeys: []
    };
  }

  function copyEnvObject(env) {
    var out = {};
    env = env || {};
    for (var key in env) {
      if (Object.prototype.hasOwnProperty.call(env, key)) {
        out[key] = env[key];
      }
    }
    return out;
  }

  function mergeEnvObject(target, source) {
    source = source || {};
    for (var key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== null && typeof source[key] !== "undefined") {
        target[key] = source[key];
      }
    }
    return target;
  }

  function codexCommand(baseCommand, entry, options, promptText) {
    var command = parseCommand(options.command, [baseCommand || "codex"]);
    var model = trim(options.model);
    var reasoningEffort = normalizeCodexReasoningEffort(options.reasoningEffort || options.reasoningLevel || options.modelReasoningEffort || entry.reasoningEffort);
    var serviceTier = trim(options.serviceTier || options.speedTier || entry.serviceTier);
    var bypass = boolValue(options.bypassApprovalsAndSandbox, true);
    var sandbox = trim(options.sandbox);
    if (entry.sessionId.length) {
      command.push("exec");
      command.push("resume");
      command.push("--json");
      if (reasoningEffort.length) {
        command.push("-c");
        command.push('model_reasoning_effort="' + tomlString(reasoningEffort) + '"');
      }
      if (serviceTier.length) {
        command.push("-c");
        command.push('service_tier="' + tomlString(serviceTier) + '"');
      }
      if (bypass) {
        command.push("--dangerously-bypass-approvals-and-sandbox");
      }
      if (model.length) {
        command.push("-m");
        command.push(model);
      }
      command.push("--skip-git-repo-check");
      command.push(entry.sessionId);
      command.push("-");
      return command;
    }

    command.push("exec");
    command.push("--json");
    if (reasoningEffort.length) {
      command.push("-c");
      command.push('model_reasoning_effort="' + tomlString(reasoningEffort) + '"');
    }
    if (serviceTier.length) {
      command.push("-c");
      command.push('service_tier="' + tomlString(serviceTier) + '"');
    }
    if (bypass) {
      command.push("--dangerously-bypass-approvals-and-sandbox");
    } else if (sandbox.length) {
      command.push("-s");
      command.push(sandbox);
    }
    if (model.length) {
      command.push("-m");
      command.push(model);
    }
    command.push("--skip-git-repo-check");
    command.push("-C");
    command.push(entry.cwd);
    command.push("-");
    return command;
  }

  C8O.agentBridge.codexStart = function (options) {
    var operationStartedAt = now();
    options = optionsWithRequestFallbacks(options || {});
    try {
      C8O.agentBridge.sweepExpired({});
    } catch (_ignoreStartSweep) {}
    try {
      ensureManagedViewerDebugPort(options);
    } catch (viewerDebugPortError) {
      return {
        ok: false,
        status: "error",
        phase: "viewer_debug_port",
        error: String(viewerDebugPortError),
        timestamp: now()
      };
    }
    if (intValue(options.viewerDebugPort, 0, 0, 65535) >= 1024) {
      options.codexHome = "";
      options.agentHome = "";
      options.codexHomeScope = "conversation";
      options.homeScope = "conversation";
    }
    var handle = trim(options.handle) || makeHandle("codex");
    var registry = getRegistry();
    var existing = registry.get(handle);
    if (existing !== null && typeof existing !== "undefined" && processAlive(existing.process)) {
      var requestedMcpTokenFingerprint = mcpBearerTokenFingerprint(options);
      var mcpTokenChanged = requestedMcpTokenFingerprint.length
        && trim(existing.mcpBearerTokenFingerprint) !== requestedMcpTokenFingerprint;
      var requestedPlaywrightCdpEndpoint = resolvePlaywrightMcpCdpEndpoint(options);
      var activePlaywrightCdpEndpoint = trim(existing.playwrightCdpEndpoint || existing.viewerCdpEndpoint);
      var requestedScopeOption = trim(options.codexHomeScope || options.homeScope || options.scope);
      var requestedScope = requestedPlaywrightCdpEndpoint.length && !requestedScopeOption.length ? "conversation" : normalizeCodexHomeScope(requestedScopeOption);
      var needsViewerScopedRestart = requestedPlaywrightCdpEndpoint.length && requestedScope === "conversation" && trim(options.codexHome || options.agentHome).length === 0 && existing.home && !isConversationScopedCodexHome(existing.home.path);
      var revealModeChanged = revealModeEnabled(options, existing) !== (existing.convertigoRevealMode === true);
      if ((requestedPlaywrightCdpEndpoint.length && activePlaywrightCdpEndpoint !== requestedPlaywrightCdpEndpoint)
          || needsViewerScopedRestart || mcpTokenChanged || revealModeChanged) {
        pushEvent(existing, "warning", {
          message: mcpTokenChanged
            ? "Codex app-server must restart to renew its managed Convertigo MCP authorization."
            : (revealModeChanged
              ? "Codex app-server must restart to update Convertigo reveal mode."
              : "Codex app-server must restart to refresh the managed Playwright MCP viewer endpoint."),
          provider: "codex",
          reason: mcpTokenChanged ? "mcp_token_renewed" : (revealModeChanged ? "reveal_mode_changed" : (needsViewerScopedRestart ? "playwright_requires_conversation_home" : (activePlaywrightCdpEndpoint.length ? "playwright_endpoint_changed" : "playwright_endpoint_available_after_start"))),
          previousEndpoint: activePlaywrightCdpEndpoint,
          requestedEndpoint: requestedPlaywrightCdpEndpoint
        });
        stopEntry(existing, true);
        existing = null;
      } else {
        writeEntryPidFile(existing);
        rememberSessionHandle(handle);
        return {
          ok: true,
          status: "already_running",
          handle: handle,
          timings: {
            acceptedAt: operationStartedAt,
            appServerReused: true,
            totalMs: now() - operationStartedAt
          },
          state: statusOf(existing),
          timestamp: now()
        };
      }
    }

    var setupStartedAt = now();
    var setup = C8O.agentBridge.codexSetup({
      workspaceRoot: options.workspaceRoot,
      installDir: options.installDir,
      codexHome: options.codexHome || options.agentHome,
      codexHomeScope: options.codexHomeScope || options.homeScope || options.scope,
      userId: options.userId,
      conversationId: options.conversationId,
      projectId: options.projectId,
      agentProfile: options.agentProfile,
      skillProfile: options.skillProfile,
      assistantContext: options.assistantContext,
      assistantSurface: options.assistantSurface,
      mcpEndpoint: options.mcpEndpoint,
      codexPath: options.codexPath || options.commandPath,
      install: options.install || options.installCodex,
      nodeVersion: options.nodeVersion,
      nodeDir: options.nodeDir || options.nodeInstallDir,
      npmPath: options.npmPath,
      allowNodeDownload: options.allowNodeDownload,
      codexPackage: options.codexPackage || options.packageName,
      codexVersion: options.codexVersion || options.packageVersion,
      codexPlaywrightMcpPackage: options.codexPlaywrightMcpPackage || options.playwrightMcpPackage,
      codexPlaywrightMcpVersion: options.codexPlaywrightMcpVersion || options.playwrightMcpVersion,
      codexPlaywrightPackage: options.codexPlaywrightPackage || options.playwrightPackage,
      codexPlaywrightVersion: options.codexPlaywrightVersion || options.playwrightVersion,
      codexInstallMethod: options.codexInstallMethod || options.installMethod,
      codexInstallTimeoutMs: options.codexInstallTimeoutMs,
      forceCodexInstall: options.forceCodexInstall || options.forceInstall,
      forceCodexPlaywrightInstall: options.forceCodexPlaywrightInstall || options.forcePlaywrightInstall,
      skipCodexPlaywrightInstall: options.skipCodexPlaywrightInstall || options.skipPlaywrightInstall,
      browserDebugUrl: options.browserDebugUrl,
      browserDevToolsJsonUrl: options.browserDevToolsJsonUrl,
      browserDevToolsWebSocketUrl: options.browserDevToolsWebSocketUrl,
      playwrightCdpEndpoint: options.playwrightCdpEndpoint || options.viewerCdpEndpoint,
      playwrightMcpEndpoint: options.playwrightMcpEndpoint,
      viewerDebugPort: options.viewerDebugPort,
      agentRevealMode: firstDefinedOption(options, ["agentRevealMode", "convertigoRevealMode", "uiRevealMode", "revealMode", "reveal"]),
      mcpSkillsSourceDir: options.mcpSkillsSourceDir || options.skillsSourceDir || options.convertigoMcpDir,
      skipSkillsInstall: options.skipSkillsInstall || options.skipSkillSync,
      nocodeMcpTokenHandle: options.nocodeMcpTokenHandle || options.noCodeMcpTokenHandle || options.mcpBearerTokenHandle,
      noCodeMcpTokenHandle: options.noCodeMcpTokenHandle,
      mcpBearerTokenHandle: options.mcpBearerTokenHandle,
      startupPresenceOnly: true
    });
    var setupCompletedAt = now();
    if (!setup.ok) {
      var authenticationRequired = setup.status === "authentication_required";
      var setupError = "codex CLI is required before start";
      if (setup.setup && setup.setup.codex && setup.setup.codex.found === true) {
        if (setup.setup.mcp && setup.setup.mcp.ok !== true) {
          var mcpError = trim(setup.setup.mcp.error || setup.setup.mcp.stderr);
          mcpError = mcpError.replace(/\s+/g, " ");
          if (mcpError.length > 600) {
            mcpError = mcpError.substring(0, 597) + "...";
          }
          setupError = "Codex MCP configuration is not usable" + (mcpError.length ? ": " + mcpError : "");
        } else if (setup.messages && setup.messages.length) {
          setupError = String(setup.messages[setup.messages.length - 1]);
        } else {
          setupError = "Codex local setup is incomplete";
        }
      }
      return {
        ok: false,
        status: authenticationRequired ? "authentication_required" : "error",
        phase: "setup",
        error: authenticationRequired ? "Codex authentication is required before start" : setupError,
        setup: setup,
        timestamp: now()
      };
    }

    var env = mergeEnvObject(codexRuntimeEnv(options, setup.setup.codexHome), parseObject(options.env, {}));
    if (setup.setup.codexHome.length) {
      env.CODEX_HOME = setup.setup.codexHome;
    }
    applyManagedMcpEnvironment(env, options);
    var nodePath = nodeRuntimeSearchPath(options);
    if (nodePath.length) {
      env.PATH = nodePath + String(File.pathSeparator) + (env.PATH || String(System.getenv("PATH") || ""));
    }
    env.TERM = env.TERM || "xterm-256color";
    var cwd = normalizeDirectory(options.cwd, setup.setup.workspaceRoot, setup.setup.workspaceRoot);
    var ttlMillis = intValue(options.ttlSeconds, DEFAULT_TTL_SECONDS, 30, 86400) * 1000;
    var orphanSweep = sweepCodexAppServerPidFiles(setup.setup.workspaceRoot, ttlMillis);
    var credentials = codexCredentials(options, setup.setup.home);
    var runtimeMode = codexRuntimeMode(options);
    if (runtimeMode !== "app-server" && runtimeMode !== "exec") {
      return {
        ok: false,
        status: "error",
        phase: "codex_start",
        error: "Unsupported Codex runtime mode: " + runtimeMode,
        setup: setup,
        timestamp: now()
      };
    }
    var protocol = runtimeMode === "exec" ? "codex-jsonl" : "codex-app-server";
    var entry = createEntry(handle, "codex", protocol, [], cwd, env, ttlMillis, setup.setup.home, credentials, options.model || options.agentModel);
    entry.workspaceRoot = setup.setup.workspaceRoot;
    var pidFile = protocol === "codex-app-server" ? codexPidFile(setup.setup.workspaceRoot, handle) : null;
    entry.pidFile = pidFile === null ? "" : filePath(pidFile);
    entry.agentProfile = trim(options.agentProfile || options.skillProfile || options.assistantContext || options.profile);
    entry.skillProfile = normalizeSkillProfile(options);
    entry.assistantContext = trim(options.assistantContext);
    entry.assistantSurface = trim(options.assistantSurface);
    entry.userId = trim(options.userId);
    entry.conversationId = trim(options.conversationId || options.threadid || (setup.setup.home && setup.setup.home.conversationId));
    entry.projectId = trim(options.projectId || options.projectName || options.targetProject || (setup.setup.home && setup.setup.home.projectId));
    entry.nocodeMcpTokenHandle = trim(options.nocodeMcpTokenHandle || options.noCodeMcpTokenHandle || options.mcpBearerTokenHandle);
    entry.noCodeMcpTokenHandle = trim(options.noCodeMcpTokenHandle);
    entry.mcpBearerTokenHandle = trim(options.mcpBearerTokenHandle);
    entry.mcpBearerTokenFingerprint = mcpBearerTokenFingerprint(options);
    entry.mcpEndpoint = resolveMcpEndpoint(options);
    entry.browserDebugUrl = trim(options.browserDebugUrl);
    entry.browserDevToolsJsonUrl = trim(options.browserDevToolsJsonUrl);
    entry.browserDevToolsWebSocketUrl = trim(options.browserDevToolsWebSocketUrl);
    entry.viewerDebugPort = intValue(options.viewerDebugPort, 0, 0, 65535);
    entry.playwrightCdpEndpoint = resolvePlaywrightMcpCdpEndpoint(options);
    entry.viewerCdpEndpoint = trim(options.viewerCdpEndpoint || entry.playwrightCdpEndpoint);
    entry.playwrightMcpEndpoint = trim(options.playwrightMcpEndpoint);
    entry.convertigoRevealMode = revealModeEnabled(options, null);
    entry.reasoningEffort = normalizeCodexReasoningEffort(options.reasoningEffort || options.reasoningLevel || options.modelReasoningEffort);
    entry.serviceTier = trim(options.serviceTier || options.speedTier);
    entry.baseEnv = copyEnvObject(env);
    entry.codexRuntimeMode = runtimeMode;
    entry.codexMcpStartupStatuses = {};
    entry.status = "ready";
    entry.phase = "ready";
    entry.sessionId = trim(options.codexThreadId || options.sessionId || options.externalSessionId);
    entry.codexThreadId = entry.sessionId;
    entry.codexHasStartedTurn = entry.sessionId.length > 0;
    entry.codexPath = setup.setup.codex.path || "codex";
    entry.managedSkillBundle = setup.skills && setup.skills.bundle
      ? setup.skills.bundle
      : managedSkillBundleState(options, setup.setup.codexHome || (setup.setup.home && setup.setup.home.path));
    entry.managedSkillBundleFingerprint = trim(entry.managedSkillBundle && entry.managedSkillBundle.fingerprint);
    entry.managedSkillBundleReadSlugs = {};
    entry.managedSkillBundleReadCalls = {};
    if (baselineFreshCodexSkillBundle(entry)) {
      pushEvent(entry, "guidance/baselined", {
        provider: "codex",
        fingerprint: entry.managedSkillBundle.fingerprint,
        reason: "fresh_conversation"
      });
    }
    registry.put(handle, entry);
    var appServerStartedAt = 0;
    var appServerReadyAt = 0;
    if (runtimeMode !== "exec") {
      try {
        appServerStartedAt = now();
        startCodexAppServer(entry, env, options, setup);
        appServerReadyAt = now();
      } catch (appServerError) {
        entry.status = "error";
        entry.phase = "error";
        entry.lastError = String(appServerError);
        pushEvent(entry, "error", {
          message: String(appServerError),
          phase: "codex_app_server_start",
          provider: "codex"
        });
        stopEntry(entry, false);
        return {
          ok: false,
          status: "error",
          phase: "codex_app_server_start",
          error: String(appServerError),
          handle: handle,
          state: statusOf(entry),
          setup: setup,
          timestamp: now()
        };
      }
    } else {
      rememberSessionHandle(handle);
      pushEvent(entry, "system/start", {
        handle: handle,
        provider: "codex",
        protocol: "codex-jsonl",
        cwd: cwd,
        codexHome: setup.setup.codexHome,
        home: publicHomeInfo(setup.setup.home),
        resumedThreadId: entry.codexThreadId,
        mcp: setup.setup.mcp,
        reasoningEffort: entry.reasoningEffort,
        serviceTier: entry.serviceTier
      });
    }
    if (orphanSweep.stopped.length) {
      pushEvent(entry, "system/sweep", {
        provider: "codex",
        stopped: orphanSweep.stopped
      });
    }

    return {
      ok: true,
      status: "started",
      handle: handle,
      sessionId: entry.sessionId,
      codexThreadId: entry.codexThreadId,
      codexRuntimeMode: entry.codexRuntimeMode,
      cursor: entry.nextIndex,
      timings: {
        acceptedAt: operationStartedAt,
        setupStartedAt: setupStartedAt,
          setupCompletedAt: setupCompletedAt,
          setupMs: setupCompletedAt - setupStartedAt,
          setupDetails: setup.timings || {},
          appServerStartedAt: appServerStartedAt,
        appServerReadyAt: appServerReadyAt,
        appServerStartMs: appServerStartedAt > 0 && appServerReadyAt >= appServerStartedAt ? appServerReadyAt - appServerStartedAt : 0,
        appServerReused: false,
        totalMs: now() - operationStartedAt
      },
      state: statusOf(entry),
      setup: setup,
      timestamp: now()
    };
  };

  C8O.agentBridge.codexPrompt = function (options) {
    var promptAcceptedAt = now();
    options = optionsWithRequestFallbacks(options || {});
    var handle = resolveHandle(options.handle);
    if (!handle.length) {
      return { ok: false, status: "error", error: "handle is required", timestamp: now() };
    }
    var entry = getRegistry().get(handle);
    if (entry === null || typeof entry === "undefined") {
      return { ok: false, status: "not_found", handle: handle, error: "Unknown handle", timestamp: now() };
    }
    if (entry.protocol === "codex-app-server") {
      if (!processAlive(entry.process)) {
        return { ok: false, status: "not_running", handle: handle, state: statusOf(entry), timestamp: now() };
      }
    } else if (processAlive(entry.process)) {
      return { ok: false, status: "busy", handle: handle, state: statusOf(entry), timestamp: now() };
    }

    var promptText = String(options.prompt || "");
    if (!trim(promptText).length) {
      return { ok: false, status: "error", handle: handle, error: "prompt is required", timestamp: now() };
    }
    if (trim(options.codexThreadId || options.sessionId || options.externalSessionId).length) {
      entry.sessionId = trim(options.codexThreadId || options.sessionId || options.externalSessionId);
      entry.codexThreadId = entry.sessionId;
    }
    if (trim(options.model || options.agentModel).length) {
      entry.model = trim(options.model || options.agentModel);
    }
    if (trim(options.reasoningEffort || options.reasoningLevel || options.modelReasoningEffort).length) {
      entry.reasoningEffort = normalizeCodexReasoningEffort(options.reasoningEffort || options.reasoningLevel || options.modelReasoningEffort);
    }
    if (trim(options.serviceTier || options.speedTier).length) {
      entry.serviceTier = trim(options.serviceTier || options.speedTier);
    }
    if (intValue(options.viewerDebugPort, 0, 0, 65535) < 1024 && Number(entry.viewerDebugPort || 0) >= 1024) {
      options.viewerDebugPort = entry.viewerDebugPort;
    }
    var requestedPlaywrightCdpEndpoint = resolvePlaywrightMcpCdpEndpoint(options);
    if (entry.protocol === "codex-app-server" && requestedPlaywrightCdpEndpoint.length) {
      var activePlaywrightCdpEndpoint = trim(entry.playwrightCdpEndpoint || entry.viewerCdpEndpoint);
      if (activePlaywrightCdpEndpoint !== requestedPlaywrightCdpEndpoint) {
        var stateBeforeRestart = statusOf(entry);
        var restartReason = activePlaywrightCdpEndpoint.length ? "playwright_endpoint_changed" : "playwright_endpoint_available_after_start";
        pushEvent(entry, "warning", {
          message: "Playwright MCP CDP endpoint changed after the Codex app-server started; restarting the managed Codex process is required before viewer automation.",
          provider: "codex",
          reason: restartReason,
          previousEndpoint: activePlaywrightCdpEndpoint,
          requestedEndpoint: requestedPlaywrightCdpEndpoint
        });
        stopEntry(entry, true);
        return {
          ok: false,
          status: "restart_required",
          reason: restartReason,
          handle: handle,
          error: "Playwright MCP needs a fresh Codex process for the current Studio JxBrowser debug endpoint.",
          previousPlaywrightCdpEndpoint: activePlaywrightCdpEndpoint,
          requestedPlaywrightCdpEndpoint: requestedPlaywrightCdpEndpoint,
          state: stateBeforeRestart,
          timestamp: now()
        };
      }
    }
    if (requestedPlaywrightCdpEndpoint.length) {
      entry.browserDebugUrl = trim(options.browserDebugUrl || entry.browserDebugUrl);
      entry.browserDevToolsJsonUrl = trim(options.browserDevToolsJsonUrl || entry.browserDevToolsJsonUrl);
      entry.browserDevToolsWebSocketUrl = trim(options.browserDevToolsWebSocketUrl || entry.browserDevToolsWebSocketUrl);
      entry.playwrightCdpEndpoint = requestedPlaywrightCdpEndpoint;
      entry.viewerCdpEndpoint = trim(options.viewerCdpEndpoint || entry.playwrightCdpEndpoint || entry.viewerCdpEndpoint);
      entry.playwrightMcpEndpoint = trim(options.playwrightMcpEndpoint || entry.playwrightMcpEndpoint);
    }
    entry.convertigoRevealMode = revealModeEnabled(options, entry);
    var runtimeOptions = {};
    for (var key in options) {
      if (Object.prototype.hasOwnProperty.call(options, key)) {
        runtimeOptions[key] = options[key];
      }
    }
    runtimeOptions.agentProfile = trim(runtimeOptions.agentProfile || entry.agentProfile || entry.skillProfile);
    runtimeOptions.skillProfile = trim(runtimeOptions.skillProfile || entry.skillProfile || entry.agentProfile);
    runtimeOptions.assistantContext = trim(runtimeOptions.assistantContext || entry.assistantContext);
    runtimeOptions.assistantSurface = trim(runtimeOptions.assistantSurface || entry.assistantSurface);
    runtimeOptions.userId = trim(runtimeOptions.userId || entry.userId);
    runtimeOptions.conversationId = trim(runtimeOptions.conversationId || runtimeOptions.threadid || entry.conversationId || (entry.home && entry.home.conversationId) || entry.handle);
    runtimeOptions.threadid = trim(runtimeOptions.threadid || runtimeOptions.conversationId);
    runtimeOptions.projectId = trim(runtimeOptions.projectId || runtimeOptions.projectName || runtimeOptions.targetProject || entry.projectId || (entry.home && entry.home.projectId));
    runtimeOptions.nocodeMcpTokenHandle = trim(runtimeOptions.nocodeMcpTokenHandle || entry.nocodeMcpTokenHandle || entry.noCodeMcpTokenHandle || entry.mcpBearerTokenHandle);
    runtimeOptions.noCodeMcpTokenHandle = trim(runtimeOptions.noCodeMcpTokenHandle || entry.noCodeMcpTokenHandle);
    runtimeOptions.mcpBearerTokenHandle = trim(runtimeOptions.mcpBearerTokenHandle || entry.mcpBearerTokenHandle);
    runtimeOptions.mcpEndpoint = trim(runtimeOptions.mcpEndpoint || entry.mcpEndpoint);
    runtimeOptions.browserDebugUrl = trim(runtimeOptions.browserDebugUrl || entry.browserDebugUrl);
    runtimeOptions.browserDevToolsJsonUrl = trim(runtimeOptions.browserDevToolsJsonUrl || entry.browserDevToolsJsonUrl);
    runtimeOptions.browserDevToolsWebSocketUrl = trim(runtimeOptions.browserDevToolsWebSocketUrl || entry.browserDevToolsWebSocketUrl);
    runtimeOptions.playwrightCdpEndpoint = trim(runtimeOptions.playwrightCdpEndpoint || entry.playwrightCdpEndpoint || entry.viewerCdpEndpoint);
    runtimeOptions.viewerCdpEndpoint = trim(runtimeOptions.viewerCdpEndpoint || entry.viewerCdpEndpoint || runtimeOptions.playwrightCdpEndpoint);
    runtimeOptions.playwrightMcpEndpoint = trim(runtimeOptions.playwrightMcpEndpoint || entry.playwrightMcpEndpoint);
    runtimeOptions.agentRevealMode = entry.convertigoRevealMode === true ? "true" : "false";
    var managedBootstrapStartedAt = now();
    var managedBootstrapCompletedAt = managedBootstrapStartedAt;
    var managedBootstrap = null;
    var managedPreflightCurrent = entry.home && trim(entry.home.path).length > 0;
    try {
      if (entry.home && trim(entry.home.path).length) {
        var latestSkillBundle = managedSkillBundleState(runtimeOptions, entry.home.path);
        var previousSkillBundleFingerprint = trim(entry.managedSkillBundleFingerprint);
        var skillBundleChanged = previousSkillBundleFingerprint.length > 0 &&
          trim(latestSkillBundle.fingerprint).length > 0 &&
          previousSkillBundleFingerprint !== latestSkillBundle.fingerprint;
        if (skillBundleChanged) {
          entry.managedSkillBundleReadSlugs = {};
          entry.managedSkillBundleReadCalls = {};
          pushEvent(entry, "warning", {
            message: "The managed Convertigo skill bundle changed; restarting Codex before the next turn.",
            provider: "codex",
            reason: "skill_bundle_changed",
            previousFingerprint: previousSkillBundleFingerprint,
            currentFingerprint: latestSkillBundle.fingerprint
          });
          var bootstrap = bootstrapCodexHome(runtimeOptions, entry.home.path, resolveMcpEndpoint(runtimeOptions));
          managedBootstrap = bootstrap;
          managedPreflightCurrent = bootstrap && bootstrap.ok !== false;
          if (bootstrap && bootstrap.ok === false) {
            pushEvent(entry, "warning", {
              message: bootstrap.error || bootstrap.message || "Unable to refresh Codex home",
              provider: "codex"
            });
          }
        }
        entry.managedSkillBundle = latestSkillBundle;
        entry.managedSkillBundleFingerprint = trim(latestSkillBundle.fingerprint);
        var configRefreshed = managedBootstrap && managedBootstrap.generated && managedBootstrap.generated.indexOf("config.toml") >= 0;
        if (entry.protocol === "codex-app-server" && (configRefreshed || skillBundleChanged)) {
          var restartOptions = runtimeOptions;
          restartOptions.handle = handle;
          restartOptions.prompt = promptText;
          restartOptions.codexHome = entry.home.path;
          restartOptions.codexHomeScope = "conversation";
          restartOptions.workspaceRoot = entry.workspaceRoot;
          restartOptions.cwd = entry.cwd;
          restartOptions.codexPath = entry.codexPath;
          restartOptions.codexRuntimeMode = entry.codexRuntimeMode;
          restartOptions.codexThreadId = codexRestartThreadId(entry);
          if (!restartOptions.codexThreadId.length) {
            restartOptions.sessionId = "";
            restartOptions.externalSessionId = "";
          }
          restartOptions.model = entry.model;
          restartOptions.reasoningEffort = entry.reasoningEffort;
          restartOptions.serviceTier = entry.serviceTier;
          restartOptions.ttlSeconds = Math.max(30, Math.floor(entry.ttlMillis / 1000));
          stopEntry(entry, true);
          var restarted = C8O.agentBridge.codexStart(restartOptions);
          if (!restarted.ok && /no rollout found for thread id/i.test(String(restarted.error || ""))) {
            restartOptions.codexThreadId = "";
            restartOptions.sessionId = "";
            restartOptions.externalSessionId = "";
            restarted = C8O.agentBridge.codexStart(restartOptions);
          }
          if (!restarted.ok) {
            return {
              ok: false,
              status: "error",
              phase: skillBundleChanged ? "codex_skill_bundle_restart" : "codex_config_restart",
              handle: handle,
              error: restarted.error || (skillBundleChanged
                ? "Unable to restart Codex after refreshing its managed skill bundle."
                : "Unable to restart Codex after refreshing its MCP configuration."),
              setup: restarted.setup || null,
              timestamp: now()
            };
          }
          return C8O.agentBridge.codexPrompt(restartOptions);
        }
      }
    } catch (refreshError) {
      pushEvent(entry, "warning", {
        message: String(refreshError),
        provider: "codex"
      });
    }
    managedBootstrapCompletedAt = now();
    if (managedPreflightCurrent) {
      promptText = withManagedGuidancePreflight(promptText, {
        mcpEndpoint: runtimeOptions.mcpEndpoint,
        skillBundle: entry.managedSkillBundle
      });
    }
    var managedPreflight = {
      setupStatus: managedPreflightCurrent ? "current" : "unverified",
      guidanceVersion: mcpProjectGuidanceVersion(),
      skillBundle: entry.managedSkillBundle || null,
      mcpEndpoint: trim(runtimeOptions.mcpEndpoint),
      configStatus: managedBootstrap && managedBootstrap.generated && managedBootstrap.generated.indexOf("config.toml") >= 0
        ? "updated"
        : (managedPreflightCurrent ? "unchanged" : "unverified"),
      timings: {
        acceptedAt: promptAcceptedAt,
        bootstrapStartedAt: managedBootstrapStartedAt,
        bootstrapCompletedAt: managedBootstrapCompletedAt,
        bootstrapMs: managedBootstrapCompletedAt - managedBootstrapStartedAt
      }
    };
    if (entry.protocol === "codex-app-server") {
      var appServerRequestId = entry.nextRequestId;
      var appServerCursor = entry.nextIndex;
      entry.status = "running";
      entry.phase = "turn";
      entry.lastCodexProgressMessage = "";
      entry.lastCodexAnswerChunk = "";
      entry.codexTurnEnded = false;
      entry.codexAppServerItems = {};
      entry.codexAppServerCompletedItems = {};
      entry.codexAppServerDeltaText = {};
      entry.codexAppServerDeltaPending = {};
      entry.codexAppServerReasoningSummaryPending = {};
      entry.codexAppServerStreamedItems = {};
      entry.codexAppServerItemDeltas = {};
      promptText = withRevealModePrompt(promptText, entry.convertigoRevealMode === true);
      if (!trim(entry.codexThreadId || entry.sessionId).length) {
        return { ok: false, status: "error", handle: handle, error: "Codex app-server thread id is missing", state: statusOf(entry), timestamp: now() };
      }
      try {
        var turnPending = sendCodexAppServerRequest(entry, "turn/start", codexTurnParams(entry, options, promptText, appServerRequestId));
        entry.codexHasStartedTurn = true;
        pushEvent(entry, "turn/start", {
          requestId: turnPending.id,
          provider: "codex",
          textLength: promptText.length,
          threadId: entry.codexThreadId,
          reasoningEffort: entry.reasoningEffort,
          serviceTier: entry.serviceTier
        });
        return {
          ok: true,
          status: "submitted",
          handle: handle,
          requestId: turnPending.id,
          cursor: appServerCursor,
          preflight: managedPreflight,
          timings: {
            acceptedAt: promptAcceptedAt,
            preflightMs: managedBootstrapCompletedAt - managedBootstrapStartedAt,
            submittedAt: now(),
            totalMs: now() - promptAcceptedAt
          },
          state: statusOf(entry),
          timestamp: now()
        };
      } catch (appServerPromptError) {
        entry.status = "error";
        entry.phase = "error";
        entry.lastError = String(appServerPromptError);
        pushEvent(entry, "turn/error", {
          message: String(appServerPromptError),
          provider: "codex"
        });
        return {
          ok: false,
          status: "error",
          handle: handle,
          error: String(appServerPromptError),
          state: statusOf(entry),
          timestamp: now()
        };
      }
    }
    var env = mergeEnvObject(copyEnvObject(entry.baseEnv), codexRuntimeEnv(runtimeOptions, entry.home && entry.home.path ? entry.home.path : ""));
    env = mergeEnvObject(env, parseObject(options.env, {}));
    if (entry.home && entry.home.path) {
      env.CODEX_HOME = entry.home.path;
    }
    env.TERM = env.TERM || "xterm-256color";
    var requestId = entry.nextRequestId++;
    var cursor = entry.nextIndex;
    entry.status = "starting";
    entry.phase = entry.sessionId.length ? "codex/resume" : "codex/exec";
    entry.lastCodexProgressMessage = "";
    entry.lastCodexAnswerChunk = "";
    entry.codexTurnEnded = false;
    promptText = withRevealModePrompt(promptText, entry.convertigoRevealMode === true);
    entry.command = codexCommand(entry.codexPath || "codex", entry, options, promptText);
    entry.envKeys = envKeys(env);
    pushEvent(entry, "turn/start", {
      requestId: requestId,
      provider: "codex",
      textLength: promptText.length,
      resumedThreadId: entry.codexThreadId,
      reasoningEffort: entry.reasoningEffort,
      serviceTier: entry.serviceTier
    });

    try {
      prepareCodexSessionWatcherForPrompt(entry);
      startProcess(entry, env);
      try {
        if (entry.writer !== null) {
          entry.writer.write(promptText);
          entry.writer.newLine();
          entry.writer.flush();
          entry.writer.close();
          entry.writer = null;
        }
      } catch (_ignoreCloseCodexStdin) {}
      return {
        ok: true,
        status: "submitted",
        handle: handle,
        requestId: requestId,
        cursor: cursor,
        preflight: managedPreflight,
        timings: {
          acceptedAt: promptAcceptedAt,
          preflightMs: managedBootstrapCompletedAt - managedBootstrapStartedAt,
          submittedAt: now(),
          totalMs: now() - promptAcceptedAt
        },
        state: statusOf(entry),
        timestamp: now()
      };
    } catch (e) {
      entry.status = "error";
      entry.phase = "error";
      entry.lastError = String(e);
      pushEvent(entry, "turn/error", {
        message: String(e),
        provider: "codex"
      });
      return {
        ok: false,
        status: "error",
        handle: handle,
        error: String(e),
        state: statusOf(entry),
        timestamp: now()
      };
    }
  };

  C8O.agentBridge.codexClose = function (options) {
    options = options || {};
    var handle = resolveHandle(options.handle);
    if (!handle.length) {
      return { ok: false, status: "error", error: "handle is required", timestamp: now() };
    }
    var registry = getRegistry();
    var entry = registry.get(handle);
    if (entry === null || typeof entry === "undefined") {
      forgetSessionHandle(handle);
      return { ok: true, status: "not_found", handle: handle, timestamp: now() };
    }
    var stateBeforeRemove = statusOf(entry);
    stopEntry(entry, true);
    return {
      ok: true,
      status: "closed",
      handle: handle,
      state: stateBeforeRemove,
      timestamp: now()
    };
  };
