// Additional MCP servers selected by Tigo. Secrets exist only in the server
// store and the child process environment, never in project declarations.
function tigoMcpConnections(options) {
  var handle = trim(
    (options || {}).tigoResourcesHandle ||
      optionOrRequest(options || {}, "tigoResourcesHandle")
  );
  if (!handle.length) {
    return [];
  }
  if (!/^lib_ConvertigoAssistant\.resources\.[a-f0-9-]+$/.test(handle)) {
    throw new Error("Invalid Tigo resource handle");
  }
  var raw = serverSecretGet(handle);
  if (!raw.length) {
    throw new Error("Tigo resource context expired; retry from Assistant");
  }
  var bundle = JSON.parse(raw);
  if (Number(bundle.expiresAt) < now()) {
    throw new Error("Tigo resource context expired; retry from Assistant");
  }
  return bundle.connections || [];
}
function tigoHeaderEnv(server, header) {
  return (
    "TIGO_MCP_" +
    server.name.substring(5).toUpperCase() +
    "_" +
    header.toUpperCase().replace(/[^A-Z0-9]/g, "_")
  );
}
function applyTigoMcpEnvironment(env, options) {
  tigoMcpConnections(options).forEach(function (s) {
    Object.keys(s.envValues || {}).forEach(function (k) {
      env[k] = s.envValues[k];
    });
    Object.keys(s.headers || {}).forEach(function (k) {
      env[tigoHeaderEnv(s, k)] =
        s.headers[k].prefix + s.envValues[s.headers[k].env];
    });
  });
  return env;
}
function patchTigoCodexConfig(text, options) {
  if (
    !trim(
      (options || {}).tigoResourcesHandle ||
        optionOrRequest(options || {}, "tigoResourcesHandle")
    ).length
  ) {
    return text;
  }
  // Only our reserved generated names are replaced; preserve every other entry.
  var lines = splitTextLines(text),
    out = [],
    skip = false;
  lines.forEach(function (line) {
    if (/^\s*\[/.test(line)) {
      skip = /^\s*\[mcp_servers\.tigo_[a-f0-9]+(?:\.|\])/.test(line);
    }
    if (!skip) {
      out.push(line);
    }
  });
  while (out.length && !trim(out[out.length - 1])) {
    out.pop();
  }
  tigoMcpConnections(options).forEach(function (s) {
    out.push("", "[mcp_servers." + s.name + "]");
    if (s.transport === "http") {
      out.push('url = "' + tomlEscape(s.url) + '"');
      var h = Object.keys(s.headers || {});
      if (h.length) {
        out.push(
          "env_http_headers = { " +
            h
              .map(function (k) {
                return (
                  '"' + tomlEscape(k) + '" = "' + tigoHeaderEnv(s, k) + '"'
                );
              })
              .join(", ") +
            " }"
        );
      }
    } else {
      out.push(
        'command = "' + tomlEscape(s.command) + '"',
        "args = " + tomlArray(s.args || []),
        "env_vars = " + tomlArray(s.env || [])
      );
    }
    out.push("startup_timeout_sec = 30");
  });
  return out.join("\n").replace(/\n*$/, "\n");
}
function addTigoClaudeServers(servers, options) {
  tigoMcpConnections(options).forEach(function (s) {
    var c;
    if (s.transport === "http") {
      c = { type: "http", url: s.url, headers: {} };
      Object.keys(s.headers || {}).forEach(function (k) {
        c.headers[k] = "${" + tigoHeaderEnv(s, k) + "}";
      });
    } else {
      c = { type: "stdio", command: s.command, args: s.args || [], env: {} };
      (s.env || []).forEach(function (k) {
        c.env[k] = "${" + k + "}";
      });
    }
    servers[s.name] = c;
  });
  return servers;
}
function tigoVibeServers(options) {
  return tigoMcpConnections(options).map(function (s) {
    if (s.transport === "http") {
      return {
        type: "http",
        name: s.name,
        url: s.url,
        headers: Object.keys(s.headers || {}).map(function (k) {
          return {
            name: k,
            value: s.headers[k].prefix + s.envValues[s.headers[k].env]
          };
        })
      };
    }
    return {
      name: s.name,
      command: s.command,
      args: s.args || [],
      env: (s.env || []).map(function (k) {
        return { name: k, value: s.envValues[k] };
      })
    };
  });
}
