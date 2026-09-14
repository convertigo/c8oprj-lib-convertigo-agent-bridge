if (typeof C8O === "undefined") {
  var C8O = {};
}

C8O.agentBridge = C8O.agentBridge || {};

(function () {
  include("js/agent_bridge_common.js");
  include("js/agent_bridge_vibe.js");
  include("js/agent_bridge_codex.js");
  include("js/agent_bridge_claude.js");
}());
