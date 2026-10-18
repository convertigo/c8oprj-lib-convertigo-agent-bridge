// Who may run the Bridge sequences. They start agents that have file tools and the Convertigo MCP, send them prompts
// and stream what they do, and the Studio listens on every network interface: anonymous callers are refused.
// Accepted:
// - a WEB_ADMIN session (the Studio user, a run driver after admin/services/engine.Authenticate);
// - the Assistant of this engine, which sends the engine caller key in CALLER_KEY_HEADER
//   (lib_ConvertigoAssistant js/agent_bridge_client.js: same server store entry, same lock).
// The key lives only in the engine memory: created on first use, new at each engine start, never written to disk.
// Accessibility does not protect these sequences: the Studio runs Private requestables over HTTP for anyone.
(function () {
  var CALLER_KEY_ENTRY = "lib_ConvertigoAgentBridge.callerKey.v1";
  var CALLER_KEY_HEADER = "X-Convertigo-Agent-Bridge-Key";

  function store() {
    try {
      if (context && context.server) {
        return context.server;
      }
    } catch (_ignoreContextServer) {}
    try {
      if (typeof server !== "undefined" && server) {
        return server;
      }
    } catch (_ignoreServer) {}
    return null;
  }

  function newCallerKey() {
    var bytes = Packages.java.lang.reflect.Array.newInstance(Packages.java.lang.Byte.TYPE, 32);
    new Packages.java.security.SecureRandom().nextBytes(bytes);
    return String(Packages.java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes));
  }

  // Read or created under the lock of the server store: on a fresh engine the Assistant and the Bridge may ask at once.
  C8O.agentBridge.callerKey = function () {
    var shared = store();
    if (shared === null) {
      return "";
    }
    var readOrCreate = function () {
      var key = shared.get(CALLER_KEY_ENTRY);
      if (key === null || typeof key === "undefined" || !String(key).length) {
        key = newCallerKey();
        shared.set(CALLER_KEY_ENTRY, key);
      }
      return String(key);
    };
    return String(new Packages.org.mozilla.javascript.Synchronizer(readOrCreate, shared)());
  };

  function sameKey(given, expected) {
    if (!given.length || !expected.length) {
      return false;
    }
    var UTF_8 = Packages.java.nio.charset.StandardCharsets.UTF_8;
    return !!Packages.java.security.MessageDigest.isEqual(
      new Packages.java.lang.String(given).getBytes(UTF_8),
      new Packages.java.lang.String(expected).getBytes(UTF_8)
    );
  }

  function headerKey() {
    try {
      var value = context.httpServletRequest.getHeader(CALLER_KEY_HEADER);
      return value === null || typeof value === "undefined" ? "" : String(value);
    } catch (_ignoreHeader) {
      return "";
    }
  }

  function webAdmin() {
    try {
      return !!Packages.com.twinsoft.convertigo.engine.Engine.authenticatedSessionManager.hasRole(
        context.httpSession,
        Packages.com.twinsoft.convertigo.engine.AuthenticatedSessionManager.Role.WEB_ADMIN
      );
    } catch (_ignoreSession) {
      return false;
    }
  }

  function describeCaller() {
    var text = "";
    try {
      text += " " + String(context.requestedObject.getName());
    } catch (_ignoreName) {}
    try {
      text += " from " + String(context.httpServletRequest.getRemoteAddr());
    } catch (_ignoreAddress) {}
    return text;
  }

  // First statement of every Public Bridge sequence, right after include("js/vibe_agent_bridge.js").
  C8O.agentBridge.requireCaller = function () {
    var key = headerKey();
    if (webAdmin() || (key.length && sameKey(key, C8O.agentBridge.callerKey()))) {
      return;
    }
    try {
      log.warn("lib_ConvertigoAgentBridge: refused" + describeCaller() + (key.length ? " (wrong caller key)" : ""));
    } catch (_ignoreLog) {}
    throw new Packages.com.twinsoft.convertigo.engine.EngineException(
      "agent_bridge_caller_refused: a WEB_ADMIN session or the Assistant of this engine is required"
    );
  };
}());
