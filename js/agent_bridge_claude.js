// Claude Code provider implementation.
// Loaded by vibe_agent_bridge.js after agent_bridge_common.js.
//
// Claude Code runs as a resident `claude -p` process that speaks the
// stream-json protocol on stdin/stdout. The managed home is a CLAUDE_CONFIG_DIR
// under <workspaceRoot>/agents/claude, the Convertigo MCP server is declared in
// a generated --mcp-config file whose Authorization header references the
// CONVERTIGO_MCP_TOKEN environment variable, so the bearer token is never
// written to disk.
  var CLAUDE_PACKAGE_NAME = "@anthropic-ai/claude-code";
  var CLAUDE_PROTOCOL = "claude-stream-json";
  var CLAUDE_MCP_CONFIG_FILE = "convertigo-mcp.json";
  var CLAUDE_CREDENTIALS_FILE = ".credentials.json";
  var CLAUDE_STATE_FILE = ".claude.json";
  var CLAUDE_INSTRUCTIONS_FILE = "CLAUDE.md";
  var CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
  var CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
  // Claude Code has no model listing command: the catalog is the set of CLI
  // aliases. The alias itself is passed to --model, so the CLI resolves the
  // latest model of each family for the signed-in account.
  var CLAUDE_MODEL_CATALOG = [
    { id: "fable", label: "Claude Fable 5", description: "Most intelligent model, for complex authoring and review work.", defaultReasoning: "", priority: 1 },
    { id: "opus", label: "Claude Opus 5", description: "Very capable model for complex authoring work.", defaultReasoning: "", priority: 2 },
    { id: "sonnet", label: "Claude Sonnet 5", description: "Balanced speed and capability.", defaultReasoning: "", priority: 3 },
    { id: "haiku", label: "Claude Haiku 4.5", description: "Fastest model for simple tasks.", defaultReasoning: "", priority: 4 }
  ];

  function claudeInstallDir(options, workspaceRoot) {
    return normalizeDirectory(options.installDir, childPath(workspaceRoot, "agents/claude"), workspaceRoot);
  }

  function claudeNpmPrefix(installDir) {
    return childPath(installDir, "npm");
  }

  function claudeLocalBin(installDir) {
    return childPath(childPath(claudeNpmPrefix(installDir), "node_modules/.bin"), scriptCommandName("claude"));
  }

  function claudePackageSpec(options) {
    var name = trim(options.claudePackage || options.packageName) || CLAUDE_PACKAGE_NAME;
    var version = trim(options.claudeVersion || options.packageVersion || options.version) || "latest";
    return version.length ? name + "@" + version : name;
  }

  function defaultClaudeHomePath() {
    return childPath(String(System.getProperty("user.home")), ".claude");
  }

  function effectiveClaudeHomePath(homePath) {
    var home = trim(homePath);
    return home.length ? home : defaultClaudeHomePath();
  }

  function isConversationScopedClaudeHome(value) {
    var text = trim(value).replace(/\\/g, "/");
    return text.indexOf("/conversations/") >= 0 && /\/claude-home\/?$/.test(text);
  }

  function resolveClaudeHome(options, installDir) {
    options = options || {};
    var explicit = trim(options.claudeHome || options.agentHome);
    if (explicit.length) {
      return {
        scope: "explicit",
        path: filePath(new File(explicit)),
        explicit: true,
        userId: trim(options.userId),
        conversationId: trim(options.conversationId),
        projectId: trim(options.projectId),
        error: ""
      };
    }
    var scope = normalizeCodexHomeScope(options.claudeHomeScope || options.homeScope || options.scope);
    var project = resolveProjectIdOption(options);
    if (scope === "default") {
      return { scope: "default", path: "", explicit: false, userId: "", conversationId: "", projectId: project, error: "" };
    }
    if (scope === "shared") {
      return { scope: "shared", path: childPath(installDir, "claude-home"), explicit: false, userId: "", conversationId: "", projectId: project, error: "" };
    }
    var root = childPath(installDir, "homes");
    var user = trim(options.userId) || contextUserId();
    if (scope === "user") {
      if (!user.length) {
        return { scope: "user", path: "", explicit: false, userId: "", conversationId: "", projectId: project, error: "userId is required for user scoped CLAUDE_CONFIG_DIR" };
      }
      var userBase = childPath(childPath(root, "users"), userPathSlug(user));
      return { scope: "user", path: childPath(userBase, "claude-home"), explicit: false, userId: user, conversationId: "", projectId: project, error: "" };
    }
    var conv = resolveConversationIdOption(options);
    var convBase;
    if (user.length) {
      convBase = childPath(childPath(root, "users"), userPathSlug(user));
      convBase = childPath(childPath(convBase, "conversations"), stableId("conversation", conv));
    } else {
      convBase = childPath(childPath(root, "conversations"), stableId("conversation", conv));
    }
    return { scope: "conversation", path: childPath(convBase, "claude-home"), explicit: false, userId: user, conversationId: conv, projectId: project, error: "" };
  }

  function claudeRuntimeEnv(options, homePath) {
    var env = {};
    options = options || {};
    var path = nodeRuntimeSearchPath(options);
    if (path.length) {
      env.PATH = path + String(File.pathSeparator) + String(System.getenv("PATH") || "");
    }
    if (trim(homePath).length) {
      env.CLAUDE_CONFIG_DIR = trim(homePath);
    }
    env.DISABLE_AUTOUPDATER = "1";
    env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE = "1";
    // Claude Code aborts MCP tool calls after 60 s by default; Convertigo tools such as
    // mobile-builder-open (wait up to 180 s), builds and batches legitimately run longer.
    env.MCP_TOOL_TIMEOUT = String(intValue(options.claudeMcpToolTimeoutMs || options.mcpToolTimeoutMs, 600000, 60000, 3600000));
    env.MCP_TIMEOUT = String(intValue(options.claudeMcpStartupTimeoutMs || options.mcpStartupTimeoutMs, 60000, 10000, 600000));
    applyManagedMcpEnvironment(env, options);
    return env;
  }

  function claudeMcpConfigFile(homePath) {
    return new File(effectiveClaudeHomePath(homePath), CLAUDE_MCP_CONFIG_FILE);
  }

  function buildClaudeMcpConfig(mcpEndpoint, options, homePath) {
    options = options || {};
    var serverName = managedMcpServerName(options);
    var headers = {};
    headers["X-Convertigo-Guidance-Version"] = codexSkillGuidanceVersion(homePath, options);
    if (usesProtectedConvertigoMcp(mcpEndpoint, options)) {
      headers.Authorization = "Bearer ${" + mcpBearerTokenEnv(options) + "}";
    }
    if (revealModeEnabled(options, null)) {
      headers["X-Convertigo-Reveal-Mode"] = "true";
    }
    if (mcpNoLogEnabled(options)) {
      headers["X-Convertigo-No-Log"] = "true";
    }
    var viewerDebugPort = intValue(options.viewerDebugPort, 0, 0, 65535);
    if (viewerDebugPort >= 1024) {
      headers["X-Convertigo-Viewer-Debug-Port"] = String(viewerDebugPort);
    }
    var servers = {};
    servers[serverName] = {
      type: "http",
      url: managedMcpTransportEndpoint(mcpEndpoint),
      headers: headers
    };
    var playwright = claudePlaywrightServer(options);
    if (playwright !== null) {
      servers.playwright = playwright;
    }
    return { mcpServers: servers };
  }

  function claudePlaywrightEnabled(options) {
    options = options || {};
    if (boolValue(options.disablePlaywrightMcp || options.skipPlaywrightMcpConfig, false)) {
      return false;
    }
    if (normalizeSkillProfile(options) === "nocode") {
      return false;
    }
    var endpoint = resolvePlaywrightMcpCdpEndpoint(options);
    if (!endpoint.length) {
      return false;
    }
    if (trim(options.claudeHome || options.agentHome).length) {
      return true;
    }
    var scopeOption = trim(options.claudeHomeScope || options.homeScope || options.scope);
    return !scopeOption.length || normalizeCodexHomeScope(scopeOption) === "conversation";
  }

  // The Playwright MCP server attaches to the Studio JxBrowser viewer through the
  // conversation-scoped CDP endpoint, exactly like the managed Codex home. The
  // package lives in the Claude npm prefix (<installDir>/npm) so no browser is
  // downloaded: PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD stays set.
  function claudePlaywrightServer(options) {
    options = options || {};
    if (!claudePlaywrightEnabled(options)) {
      return null;
    }
    var workspaceRoot = resolveWorkspaceRoot(options);
    var installDir = claudeInstallDir(options, workspaceRoot);
    if (!new File(childPath(childPath(codexNodeModulesPath(installDir), "@playwright/mcp"), "package.json")).isFile()) {
      return null;
    }
    var direct = playwrightMcpDirectLaunch(options, installDir);
    return {
      type: "stdio",
      command: direct !== null ? direct.command : codexPlaywrightMcpCommand(options, installDir),
      args: direct !== null ? direct.args : ["--prefix", codexNpmPrefix(installDir), codexPlaywrightMcpBinaryName(options), "--cdp-endpoint", resolvePlaywrightMcpCdpEndpoint(options), "--shared-browser-context"],
      env: { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" }
    };
  }

  function writeClaudeMcpConfig(homePath, mcpEndpoint, options) {
    var file = claudeMcpConfigFile(homePath);
    var next = JSON.stringify(buildClaudeMcpConfig(mcpEndpoint, options, homePath), null, 2) + "\n";
    var previous = file.isFile() ? readTextFile(file) : "";
    if (previous === next) {
      return false;
    }
    writeTextFile(file, next);
    return true;
  }

  function inspectClaudeMcpConfig(homePath, options) {
    var capabilityProfile = agentCapabilityProfile(options || {});
    var result = {
      checked: true,
      ok: false,
      hasConvertigo: false,
      hasLegacy: false,
      hasFlow: false,
      hasManagedServer: false,
      managedServerName: capabilityProfile.mcpServerName,
      hasPlaywright: false,
      path: "",
      stdout: "",
      stderr: "",
      error: ""
    };
    try {
      var file = claudeMcpConfigFile(homePath);
      result.path = filePath(file);
      if (!file.isFile()) {
        result.error = CLAUDE_MCP_CONFIG_FILE + " not found";
        return result;
      }
      var parsed = parseJsonSafe(readTextFile(file), null);
      var servers = parsed && parsed.mcpServers && typeof parsed.mcpServers === "object" ? parsed.mcpServers : {};
      result.hasLegacy = Object.prototype.hasOwnProperty.call(servers, "convertigo");
      result.hasFlow = Object.prototype.hasOwnProperty.call(servers, "convertigo-flow");
      result.hasManagedServer = Object.prototype.hasOwnProperty.call(servers, capabilityProfile.mcpServerName);
      result.hasConvertigo = result.hasLegacy || result.hasFlow || result.hasManagedServer;
      result.hasPlaywright = Object.prototype.hasOwnProperty.call(servers, "playwright");
      result.ok = result.hasManagedServer;
    } catch (error) {
      result.error = String(error);
    }
    return result;
  }

  function claudeCommandCandidates(options, installDir) {
    var userHome = String(System.getProperty("user.home"));
    return [
      trim(options.claudePath || options.commandPath),
      claudeLocalBin(installDir),
      childPath(childPath(userHome, ".local"), "bin/claude"),
      childPath(childPath(userHome, ".claude"), "local/claude"),
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
      "claude"
    ];
  }

  function detectClaudeRuntimePresence(options) {
    options = options || {};
    var workspaceRoot = resolveWorkspaceRoot(options);
    var installDir = claudeInstallDir(options, workspaceRoot);
    var home = resolveClaudeHome(options, installDir);
    var command = firstExistingCommand(claudeCommandCandidates(options, installDir), nodeRuntimeSearchPath(options));
    if (command.found && commandPathStartsWith(command, installDir)) {
      var version = installedNpmPackageVersion(installDir, npmPackageNameFromSpec(claudePackageSpec(options)));
      command.version = version.length ? version + " (Claude Code)" : "";
    }
    return {
      workspaceRoot: workspaceRoot,
      installDir: installDir,
      claudeHome: home.path,
      home: publicHomeInfo(home),
      mcpEndpoint: resolveMcpEndpoint(options),
      claude: command,
      playwright: {
        installed: new File(childPath(childPath(codexNodeModulesPath(installDir), "@playwright/mcp"), "package.json")).isFile()
      },
      mcp: inspectClaudeMcpConfig(home.path, options)
    };
  }

  function detectClaudeRuntime(options) {
    options = options || {};
    var workspaceRoot = resolveWorkspaceRoot(options);
    var installDir = claudeInstallDir(options, workspaceRoot);
    var home = resolveClaudeHome(options, installDir);
    var command = firstWorkingCommand(claudeCommandCandidates(options, installDir), ["--version"], nodeRuntimeSearchPath(options));
    return {
      workspaceRoot: workspaceRoot,
      installDir: installDir,
      claudeHome: home.path,
      home: publicHomeInfo(home),
      mcpEndpoint: resolveMcpEndpoint(options),
      claude: command,
      playwright: detectCodexPlaywrightRuntime(options, installDir),
      mcp: inspectClaudeMcpConfig(home.path, options)
    };
  }

  function compactClaudeSetup(setup) {
    setup = setup || {};
    var mcp = setup.mcp || {};
    return {
      workspaceRoot: String(setup.workspaceRoot || ""),
      installDir: String(setup.installDir || ""),
      claudeHome: String(setup.claudeHome || ""),
      home: setup.home || {},
      mcpEndpoint: String(setup.mcpEndpoint || ""),
      claude: compactCommandStatus(setup.claude),
      playwright: {
        installed: !!(setup.playwright && (setup.playwright.installed === true || setup.playwright.found === true || setup.playwright.packageExists === true)),
        version: String(setup.playwright && setup.playwright.version || "")
      },
      mcp: {
        checked: mcp.checked === true,
        ok: mcp.ok === true,
        hasConvertigo: mcp.hasConvertigo === true,
        hasManagedServer: mcp.hasManagedServer === true,
        managedServerName: String(mcp.managedServerName || ""),
        path: String(mcp.path || ""),
        error: String(mcp.error || "")
      }
    };
  }

  function ensureClaudeRuntime(options) {
    options = options || {};
    var before = detectClaudeRuntime(options);
    var force = boolValue(options.forceClaudeInstall || options.forceInstall || options.force, false);
    var workspaceFirstOption = typeof options.workspaceInstallFirst !== "undefined" ? options.workspaceInstallFirst : options.preferWorkspaceInstall;
    var workspaceFirst = boolValue(typeof workspaceFirstOption === "undefined" ? true : workspaceFirstOption, true);
    var reused = function (attempted, steps) {
      return {
        attempted: attempted,
        installed: false,
        reused: true,
        method: "existing",
        package: "",
        npm: null,
        before: before.claude,
        claude: before.claude,
        steps: steps || [],
        timestamp: now()
      };
    };
    if (before.claude.found && !force && (!workspaceFirst || commandPathStartsWith(before.claude, before.installDir))) {
      var existing = reused(false, []);
      existing.playwright = ensureClaudePlaywrightRuntime(options, before.installDir, before.claude);
      return existing;
    }
    var method = trim(options.claudeInstallMethod || options.installMethod) || "npm";
    if (method !== "npm") {
      throw new Error("Unsupported Claude install method: " + method);
    }
    var lock = acquireFileLock(new File(childPath(before.installDir, "claude-install.lock")), intValue(options.claudeInstallLockTimeoutMs, 600000, 10000, 3600000));
    var steps = [];
    try {
      before = detectClaudeRuntime(options);
      if (before.claude.found && !force && (!workspaceFirst || commandPathStartsWith(before.claude, before.installDir))) {
        return reused(true, steps);
      }
      var fallbackClaude = before.claude.found && !commandPathStartsWith(before.claude, before.installDir) ? before.claude : null;
      try {
        ensureDirectory(new File(before.installDir));
        var npmPrefix = claudeNpmPrefix(before.installDir);
        ensureDirectory(new File(npmPrefix));
        var npmRuntime = ensureNpmRuntime(options);
        var packageSpec = claudePackageSpec(options);
        var installOptions = { codexInstallTimeoutMs: options.claudeInstallTimeoutMs || options.npmInstallTimeoutMs };
        var install = runNpmInstall(npmRuntime.npm, packageSpec, npmPrefix, installOptions);
        steps.push({ action: "npm_install", package: packageSpec, prefix: npmPrefix, result: install });
        if (!install.ok) {
          throw new Error("Unable to install Claude Code with npm: " + (install.stderr || install.stdout || install.error));
        }
        var afterOptions = {};
        for (var key in options) {
          if (Object.prototype.hasOwnProperty.call(options, key)) {
            afterOptions[key] = options[key];
          }
        }
        afterOptions.claudePath = claudeLocalBin(before.installDir);
        var after = detectClaudeRuntime(afterOptions);
        if (!after.claude.found) {
          throw new Error("Claude Code package was installed but no runnable claude executable was found");
        }
        return {
          attempted: true,
          installed: true,
          reused: false,
          method: "npm",
          package: packageSpec,
          npm: npmRuntime,
          before: before.claude,
          claude: after.claude,
          claudePath: after.claude.path,
          playwright: ensureClaudePlaywrightRuntime(options, before.installDir, after.claude),
          steps: steps,
          timestamp: now()
        };
      } catch (installError) {
        if (workspaceFirst && fallbackClaude !== null && !force) {
          return {
            attempted: true,
            installed: false,
            reused: true,
            method: "workspace_install_failed_user_fallback",
            package: claudePackageSpec(options),
            npm: null,
            before: before.claude,
            claude: fallbackClaude,
            claudePath: fallbackClaude.path,
            steps: steps,
            error: String(installError),
            timestamp: now()
          };
        }
        throw installError;
      }
    } finally {
      lock.release();
    }
  }

  function ensureClaudePlaywrightRuntime(options, installDir, claudeCommand) {
    if (!claudeCommand || !commandPathStartsWith(claudeCommand, installDir)) {
      return { attempted: false, installed: false, reused: false, skipped: true, method: "external_claude", steps: [], timestamp: now() };
    }
    try {
      return ensureCodexPlaywrightRuntime(options, installDir);
    } catch (playwrightError) {
      return { attempted: true, installed: false, reused: false, skipped: false, method: "npm", error: String(playwrightError), steps: [], timestamp: now() };
    }
  }

  function claudeLatestVersion(options, setup) {
    options = options || {};
    var managedPathPrefix = String(setup.installDir || "");
    if (!setup.claude || setup.claude.found !== true) {
      return { checked: false, latestVersion: "", error: "", checkedAt: 0, managedPathPrefix: managedPathPrefix };
    }
    var packageName = npmPackageNameFromSpec(claudePackageSpec(options));
    var cacheKey = "claude:" + packageName;
    if (!boolValue(options.checkUpdates, false)) {
      var cachedLatest = readCachedRuntimeUpdate(cacheKey, setup.workspaceRoot);
      if (cachedLatest !== null) {
        cachedLatest.managedPathPrefix = managedPathPrefix;
        return cachedLatest;
      }
      return { checked: false, latestVersion: "", error: "", checkedAt: 0, managedPathPrefix: managedPathPrefix };
    }
    var latest = cachedRuntimeUpdate(cacheKey, options, setup.workspaceRoot, function () {
      var npmRuntime = detectNpmRuntime(options);
      if (!npmRuntime.npm.found) {
        return { checked: true, latestVersion: "", error: "npm not found" };
      }
      var probe = runNpmCommand(npmRuntime.npm, ["view", packageName, "version", "--json"], {
        timeoutMs: intValue(options.updateCheckTimeoutMs, 20000, 1000, 120000)
      });
      var parsed = parseJsonSafe(probe.stdout, "");
      var value = typeof parsed === "string" ? parsed : probe.stdout;
      return {
        checked: true,
        latestVersion: extractRuntimeVersion(value),
        error: probe.ok ? "" : String(probe.stderr || probe.error || "npm version check failed")
      };
    });
    latest.managedPathPrefix = managedPathPrefix;
    return latest;
  }

  // Authentication ---------------------------------------------------------

  function emptyClaudeCredentialsState() {
    return { exists: false, expired: false, stale: false, expiresAt: 0, updatedAt: 0, hasRefreshToken: false, method: "" };
  }

  function claudeCredentialsState(file) {
    if (!fileHasContent(file)) {
      return emptyClaudeCredentialsState();
    }
    var parsed = readJsonFile(file) || {};
    var oauth = parsed.claudeAiOauth || parsed.oauth || {};
    var accessToken = trim(oauth.accessToken || oauth.access_token);
    var apiKey = trim(parsed.apiKey || parsed.anthropicApiKey);
    if (!accessToken.length && !apiKey.length) {
      return emptyClaudeCredentialsState();
    }
    var expiresAt = Number(oauth.expiresAt || oauth.expires_at || 0);
    var hasRefreshToken = trim(oauth.refreshToken || oauth.refresh_token).length > 0;
    var outdated = expiresAt > 0 && expiresAt <= now() + 60000;
    return {
      exists: true,
      // Hard expiry: nothing local can revive the session.
      expired: outdated && !hasRefreshToken,
      // A refresh token is only a promise: it may have been revoked server side, so the
      // copy is "stale" and must be re-validated instead of being trusted for ever.
      stale: outdated && hasRefreshToken,
      expiresAt: expiresAt,
      updatedAt: Number(file.lastModified() || 0),
      hasRefreshToken: hasRefreshToken,
      method: accessToken.length ? "oauth" : "api_key"
    };
  }

  function isMacOs() {
    try {
      return String(System.getProperty("os.name") || "").toLowerCase().indexOf("mac") >= 0;
    } catch (_ignoreOsName) {
      return false;
    }
  }

  function readKeychainClaudeCredentials() {
    if (!isMacOs()) {
      return "";
    }
    try {
      var probe = runCommand(["/usr/bin/security", "find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"], { timeoutMs: 8000 });
      if (!probe.ok) {
        return "";
      }
      var text = trim(probe.stdout);
      var parsed = parseJsonSafe(text, null);
      return parsed && typeof parsed === "object" ? text : "";
    } catch (_ignoreKeychain) {
      return "";
    }
  }

  function claudeCredentialSourceDirs(options, homeDir) {
    options = options || {};
    var sources = [];
    var workspaceRoot = resolveWorkspaceRoot(options);
    var installDir = claudeInstallDir(options, workspaceRoot);
    var userHome = resolveClaudeHome({
      workspaceRoot: workspaceRoot,
      installDir: installDir,
      claudeHomeScope: "user",
      userId: trim(options.userId) || contextUserId()
    }, installDir);
    if (trim(userHome.path).length && filePath(new File(userHome.path)) !== filePath(homeDir)) {
      sources.push(new File(userHome.path));
    }
    sources.push(new File(defaultClaudeHomePath()));
    return sources;
  }

  function newestUsableClaudeCredentialsFile(directories) {
    var selected = null;
    for (var i = 0; directories && i < directories.length; i++) {
      var candidate = new File(directories[i], CLAUDE_CREDENTIALS_FILE);
      var state = claudeCredentialsState(candidate);
      if (!state.exists || state.expired) {
        continue;
      }
      if (selected === null || Number(candidate.lastModified()) > Number(selected.lastModified())) {
        selected = candidate;
      }
    }
    return selected;
  }

  function writeClaudeCredentialsFile(targetDir, text) {
    var target = new File(targetDir, CLAUDE_CREDENTIALS_FILE);
    writeTextFile(target, String(text).replace(/\n*$/, "\n"));
    try {
      target.setReadable(false, false);
      target.setReadable(true, true);
      target.setWritable(false, false);
      target.setWritable(true, true);
    } catch (_ignoreCredentialPermissions) {}
    return target;
  }

  // Identity of a stored session: the tokens and their expiry, whatever the file layout.
  function claudeCredentialsFingerprint(text) {
    var parsed = parseJsonSafe(trim(text), null);
    if (parsed === null || typeof parsed !== "object") {
      return trim(text);
    }
    var oauth = parsed.claudeAiOauth || parsed.oauth || {};
    return [
      trim(oauth.accessToken || oauth.access_token),
      trim(oauth.refreshToken || oauth.refresh_token),
      String(Number(oauth.expiresAt || oauth.expires_at || 0)),
      trim(parsed.apiKey || parsed.anthropicApiKey)
    ].join("|");
  }

  function syncClaudeCredentials(sourceDirs, homeDir, report) {
    var target = new File(homeDir, CLAUDE_CREDENTIALS_FILE);
    var targetState = claudeCredentialsState(target);
    var source = newestUsableClaudeCredentialsFile(sourceDirs);
    if (source !== null) {
      syncAgentUserFile(source.getParentFile(), homeDir, CLAUDE_CREDENTIALS_FILE, report, targetState.exists && targetState.expired);
      report.authenticationSource = filePath(source.getParentFile());
      report.authenticationImported = !targetState.exists || targetState.expired;
      return;
    }
    // No readable file source. On macOS `~/.claude/.credentials.json` never exists: the
    // credentials live in the Keychain and the managed copy is only a snapshot. Re-read the
    // Keychain and refresh the copy as soon as it differs, otherwise a rotated or revoked
    // session is kept for ever and the agent keeps declaring itself authenticated.
    var keychain = trim(readKeychainClaudeCredentials());
    if (keychain.length) {
      var current = "";
      try {
        current = fileHasContent(target) ? readTextFile(target) : "";
      } catch (_ignoreCredentialCompare) {
        current = "";
      }
      // Compare the tokens, not the bytes: the CLI rewrites the file in its own layout, so
      // a raw text comparison would copy the very same session over and over.
      if (!targetState.exists || claudeCredentialsFingerprint(current) !== claudeCredentialsFingerprint(keychain)) {
        writeClaudeCredentialsFile(homeDir, keychain);
        report.copied.push(CLAUDE_CREDENTIALS_FILE);
        report.authenticationSource = "keychain";
        report.authenticationImported = true;
        return;
      }
      report.reused.push(CLAUDE_CREDENTIALS_FILE);
      report.authenticationSource = "keychain";
      return;
    }
    if (targetState.exists && !targetState.expired) {
      report.reused.push(CLAUDE_CREDENTIALS_FILE);
    }
  }

  function inspectClaudeAuthentication(homePath) {
    if (environmentHasValue("ANTHROPIC_API_KEY") || environmentHasValue("CLAUDE_CODE_OAUTH_TOKEN")) {
      return authenticationInfo(true, "environment", "");
    }
    var homes = [];
    if (trim(homePath).length) {
      homes.push(new File(trim(homePath)));
    }
    homes.push(new File(defaultClaudeHomePath()));
    var firstExpired = null;
    var seen = {};
    for (var i = 0; i < homes.length; i++) {
      var path = filePath(homes[i]);
      if (seen[path]) {
        continue;
      }
      seen[path] = true;
      var scoped = i === 0 && trim(homePath).length > 0;
      var state = claudeCredentialsState(new File(homes[i], CLAUDE_CREDENTIALS_FILE));
      if (!state.exists) {
        continue;
      }
      if (state.expired) {
        var expired = authenticationInfo(false, "", "claude_login", "expired");
        expired.expiresAt = state.expiresAt;
        expired.home = path;
        if (firstExpired === null) {
          firstExpired = expired;
        }
        continue;
      }
      var info = authenticationInfo(true, scoped ? "scoped_home" : "user_home", "");
      info.home = path;
      info.expiresAt = state.expiresAt;
      info.updatedAt = state.updatedAt;
      if (state.stale === true) {
        // The access token is past its expiry and only a refresh token is left: the CLI may
        // still be able to refresh it, so stay configured, but ask for a real check.
        info.status = "stale";
        info.staleCredentials = true;
      }
      return info;
    }
    if (readKeychainClaudeCredentials().length) {
      return authenticationInfo(true, "keychain", "");
    }
    return firstExpired !== null ? firstExpired : authenticationInfo(false, "", "claude_login");
  }

  // Authentication probe ---------------------------------------------------
  //
  // Codex has `codex doctor` plus an app-server probe (agent_bridge_common.js) to tell a
  // revoked session from a healthy one. Claude had nothing: `claude auth status` was only
  // run when the credentials file already said "not configured", so a revoked session that
  // still has a refresh token on disk stayed `configured: true` for ever. The probe below
  // is the Claude equivalent: it asks the CLI, caches the answer, and never breaks the
  // settings call when the CLI is missing, slow or answers something unexpected.

  var CLAUDE_AUTH_PROBE_CACHE_KEY = "lib_ConvertigoAgentBridge.claudeAuthProbeCache.v1";
  var CLAUDE_AUTH_PROBE_CACHE_FILE = "claude-auth-checks.json";
  var CLAUDE_AUTH_PROBE_CACHE_MS = 300000;

  // Wordings the Claude CLI and the Anthropic API use when the stored OAuth session cannot
  // be used any more (revoked, refresh refused, signed out elsewhere).
  var CLAUDE_REVOKED_SESSION_PATTERNS = [
    "not logged in",
    "please run /login",
    "please run `claude login`",
    "please log in again",
    "please sign in again",
    "authentication_error",
    "invalid api key",
    "invalid bearer token",
    "oauth token has expired",
    "oauth token expired",
    "oauth token is invalid",
    "oauth token revoked",
    "token has been revoked",
    "refresh token was revoked",
    "refresh token has expired",
    "refresh token not found",
    "refresh token is invalid",
    "invalid refresh token",
    "failed to refresh",
    "could not refresh",
    "unable to refresh",
    "invalid_grant",
    "session has expired",
    "session expired",
    "credentials are invalid",
    "401 unauthorized"
  ];

  function claudeMatchesAny(text, patterns) {
    var lower = String(text || "").toLowerCase();
    if (!lower.length) {
      return false;
    }
    for (var i = 0; i < patterns.length; i++) {
      if (lower.indexOf(patterns[i]) !== -1) {
        return true;
      }
    }
    return false;
  }

  function claudeLooksLikeRevokedSession(text) {
    return claudeMatchesAny(text, CLAUDE_REVOKED_SESSION_PATTERNS);
  }

  // Small local cache, in the spirit of cachedRuntimeUpdate() but kept inside this file so
  // the Claude probe owns its own (much shorter) lifetime. It lives in the engine server
  // store when there is one, so it survives between sequence executions.
  function claudeAuthProbeCacheMap() {
    try {
      var store = getServerStore();
      if (store !== null) {
        var cache = store.get(CLAUDE_AUTH_PROBE_CACHE_KEY);
        if (cache === null || typeof cache === "undefined") {
          cache = new ConcurrentHashMap();
          store.set(CLAUDE_AUTH_PROBE_CACHE_KEY, cache);
        }
        return cache;
      }
    } catch (_ignoreClaudeAuthProbeStore) {}
    if (!C8O.agentBridge._claudeAuthProbeCache) {
      C8O.agentBridge._claudeAuthProbeCache = {};
    }
    return C8O.agentBridge._claudeAuthProbeCache;
  }

  // The engine store does not always survive between sequence executions (that is why the
  // shared runtime cache also has a file), so the probe answer is mirrored in a small JSON
  // file next to the managed agents. Both layers are best effort: any failure just means
  // one more `claude auth status` call.
  function claudeAuthProbeCacheFile(options) {
    try {
      var root = trim(resolveWorkspaceRoot(options || {}));
      return root.length ? new File(childPath(root, "agents"), CLAUDE_AUTH_PROBE_CACHE_FILE) : null;
    } catch (_ignoreClaudeAuthProbeFile) {
      return null;
    }
  }

  function claudeAuthProbeFileRead(options, key) {
    try {
      var file = claudeAuthProbeCacheFile(options);
      if (file === null || !fileHasContent(file)) {
        return null;
      }
      var value = readJsonFile(file);
      var stored = value && value.checks ? value.checks[key] : null;
      return stored && typeof stored === "object" ? stored : null;
    } catch (_ignoreClaudeAuthProbeFileRead) {
      return null;
    }
  }

  function claudeAuthProbeFileWrite(options, key, value) {
    var lock = null;
    try {
      var file = claudeAuthProbeCacheFile(options);
      if (file === null) {
        return;
      }
      ensureDirectory(file.getParentFile());
      try {
        lock = acquireFileLock(new File(file.getParentFile(), CLAUDE_AUTH_PROBE_CACHE_FILE + ".lock"), 5000);
      } catch (_ignoreClaudeAuthProbeLock) {
        lock = null;
      }
      var current = readJsonFile(file);
      if (current === null || typeof current !== "object" || typeof current.checks !== "object" || current.checks === null) {
        current = { version: 1, checks: {} };
      }
      var currentTime = now();
      for (var existing in current.checks) {
        if (Object.prototype.hasOwnProperty.call(current.checks, existing) &&
          Number(current.checks[existing] && current.checks[existing].nextCheckAt || 0) <= currentTime) {
          delete current.checks[existing];
        }
      }
      current.checks[key] = value;
      writeTextFile(file, JSON.stringify(current));
    } catch (_ignoreClaudeAuthProbeFileWrite) {
    } finally {
      try { if (lock !== null) { lock.release(); } } catch (_ignoreClaudeAuthProbeUnlock) {}
    }
  }

  function claudeAuthProbeCacheRead(cache, key) {
    try {
      var raw = typeof cache.get === "function" ? cache.get(key) : cache[key];
      if (raw === null || typeof raw === "undefined") {
        return null;
      }
      return parseJsonSafe(String(raw), null);
    } catch (_ignoreClaudeAuthProbeRead) {
      return null;
    }
  }

  function claudeAuthProbeCacheWrite(cache, key, value) {
    try {
      var raw = JSON.stringify(value);
      if (typeof cache.put === "function") {
        cache.put(key, raw);
      } else {
        cache[key] = raw;
      }
    } catch (_ignoreClaudeAuthProbeWrite) {}
  }

  function claudeCachedAuthenticationProbe(key, options, loader) {
    options = options || {};
    var cacheMs = intValue(options.claudeAuthCheckCacheMs, CLAUDE_AUTH_PROBE_CACHE_MS, 0, 86400000);
    // Only an explicit Claude authentication refresh (a sign-in, or a caller asking for a
    // forced check) bypasses the window: `refreshUpdateCheck` is the runtime/version flag
    // and the settings call sets it routinely, which would defeat the cache entirely.
    var refresh = boolValue(options.refreshClaudeAuthCheck, false);
    var cache = claudeAuthProbeCacheMap();
    var currentTime = now();
    if (!refresh && cacheMs > 0) {
      var cached = claudeAuthProbeCacheRead(cache, key);
      if (cached !== null && Number(cached.nextCheckAt || 0) > currentTime) {
        cached.cached = true;
        return cached;
      }
      var persisted = claudeAuthProbeFileRead(options, key);
      if (persisted !== null && Number(persisted.nextCheckAt || 0) > currentTime) {
        persisted.cached = true;
        claudeAuthProbeCacheWrite(cache, key, persisted);
        return persisted;
      }
    }
    var loaded = loader();
    loaded.checkedAt = currentTime;
    loaded.nextCheckAt = cacheMs > 0 ? currentTime + cacheMs : currentTime;
    loaded.cached = false;
    // Only a conclusive answer is worth caching: a timeout or a missing CLI must be retried.
    if (loaded.conclusive === true && cacheMs > 0) {
      claudeAuthProbeCacheWrite(cache, key, loaded);
      claudeAuthProbeFileWrite(options, key, loaded);
    }
    return loaded;
  }

  function claudeAuthenticationProbe(options, homePath, commandPath) {
    var startedAt = now();
    var result = {
      checked: true,
      conclusive: false,
      valid: false,
      unauthorized: false,
      loggedIn: false,
      authMethod: "",
      reason: "",
      error: "",
      durationMs: 0
    };
    var command = trim(commandPath);
    if (!command.length) {
      result.reason = "cli_missing";
      result.error = "The Claude CLI is not available; authentication was not verified.";
      result.durationMs = now() - startedAt;
      return result;
    }
    var probe = null;
    try {
      probe = runCommand([command, "auth", "status"], {
        timeoutMs: intValue(options && options.claudeAuthCheckTimeoutMs, intValue(options && options.authProbeTimeoutMs, 10000, 1000, 60000), 1000, 60000),
        env: claudeRuntimeEnv(options || {}, homePath)
      });
    } catch (e) {
      result.reason = "probe_failed";
      result.error = String(e);
      result.durationMs = now() - startedAt;
      return result;
    }
    var output = String((probe.stdout || "") + "\n" + (probe.stderr || ""));
    result.exitCode = Number(probe.exitCode);
    if (trim(probe.error) === "timeout") {
      result.reason = "timeout";
      result.error = "The `claude auth status` probe timed out.";
      result.durationMs = now() - startedAt;
      return result;
    }
    var parsed = parseJsonSafe(trim(probe.stdout), null);
    if (parsed && typeof parsed === "object" && typeof parsed.loggedIn !== "undefined") {
      var loggedIn = parsed.loggedIn === true || String(parsed.loggedIn) === "true";
      result.conclusive = true;
      result.loggedIn = loggedIn;
      result.authMethod = trim(parsed.authMethod || parsed.auth_method || "");
      result.valid = loggedIn && !claudeLooksLikeRevokedSession(probe.stderr);
      result.unauthorized = !result.valid;
      result.reason = result.valid ? "logged_in" : "logged_out";
      return finishClaudeAuthenticationProbe(result, startedAt);
    }
    if (claudeLooksLikeRevokedSession(output)) {
      result.conclusive = true;
      result.unauthorized = true;
      result.reason = "revoked";
      result.error = trim(output).substring(0, 400);
      return finishClaudeAuthenticationProbe(result, startedAt);
    }
    if (claudeMatchesAny(output, ["command not found", "no such file or directory", "is not recognized"])) {
      result.reason = "cli_missing";
      result.error = trim(output).substring(0, 400);
      return finishClaudeAuthenticationProbe(result, startedAt);
    }
    result.reason = "unexpected_output";
    result.error = trim(output).substring(0, 400) || ("`claude auth status` exited with " + probe.exitCode);
    return finishClaudeAuthenticationProbe(result, startedAt);
  }

  function finishClaudeAuthenticationProbe(result, startedAt) {
    result.durationMs = now() - startedAt;
    return result;
  }

  function claudeDoctorAuthentication(options, homePath, commandPath, forceCheck) {
    var authentication = inspectClaudeAuthentication(homePath);
    var command = trim(commandPath);
    if (!command.length) {
      // Presence-only settings call, or no CLI at all: keep the file/Keychain verdict.
      authentication.check = { checked: false, reason: "cli_missing" };
      return authentication;
    }
    if (authentication.configured === true && trim(authentication.method) === "environment") {
      // ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN win over the stored session.
      return authentication;
    }
    var probeOptions = {};
    options = options || {};
    for (var key in options) {
      if (Object.prototype.hasOwnProperty.call(options, key)) {
        probeOptions[key] = options[key];
      }
    }
    if (forceCheck === true) {
      probeOptions.refreshClaudeAuthCheck = true;
    }
    // The cache key carries the credentials timestamps: a refreshed or re-imported session
    // invalidates it on its own, so a stale copy still costs at most one probe per window.
    // The key stays on the CLI and the home: `claude auth status` itself refreshes and
    // rewrites the credentials file, so keying on its timestamps would miss the cache on
    // every single call. The short window plus the forced check on login covers freshness.
    var cacheKey = "claude-auth:" + hashShort(command + ":" + filePath(new File(effectiveClaudeHomePath(homePath))));
    var probe = null;
    try {
      probe = claudeCachedAuthenticationProbe(cacheKey, probeOptions, function () {
        return claudeAuthenticationProbe(probeOptions, homePath, command);
      });
    } catch (_ignoreAuthProbe) {
      probe = null;
    }
    if (probe === null) {
      authentication.check = { checked: false, reason: "probe_failed" };
      return authentication;
    }
    authentication.check = probe;
    authentication.checked = true;
    authentication.checkMethod = "auth-status";
    if (probe.conclusive !== true) {
      // Missing CLI, timeout or unexpected output: never let the probe break the settings
      // call, fall back to what the credentials say and report why.
      authentication.checkFallbackReason = trim(probe.reason) || "unknown";
      return authentication;
    }
    if (probe.unauthorized === true) {
      var revoked = authenticationInfo(false, "", "claude_login", probe.reason === "revoked" ? "revoked" : "expired");
      revoked.home = trim(authentication.home);
      revoked.expiresAt = Number(authentication.expiresAt || 0);
      revoked.updatedAt = Number(authentication.updatedAt || 0);
      revoked.checked = true;
      revoked.checkMethod = "auth-status";
      revoked.check = probe;
      revoked.verifiedByCli = true;
      revoked.message = "The stored Claude session is no longer usable. Sign in again to Claude Code.";
      return revoked;
    }
    if (authentication.configured !== true || trim(authentication.status) === "stale") {
      var verified = authenticationInfo(true, "cli:" + (trim(probe.authMethod) || "unknown"), "");
      verified.home = trim(authentication.home);
      verified.expiresAt = Number(authentication.expiresAt || 0);
      verified.updatedAt = Number(authentication.updatedAt || 0);
      verified.checked = true;
      verified.checkMethod = "auth-status";
      verified.check = probe;
      verified.verifiedByCli = true;
      return verified;
    }
    authentication.verifiedByCli = true;
    return authentication;
  }

  // Browser login ----------------------------------------------------------
  //
  // `claude auth login` opens the Anthropic OAuth page in a browser and waits for the
  // localhost callback. On POSIX hosts the bridge points BROWSER to a tiny script that
  // records the URL instead, so the Studio UI opens it in the user's browser exactly
  // like the Codex flow. On Windows Claude Code opens the default browser itself.

  var CLAUDE_LOGIN_URL_FILE_ENV = "C8O_CLAUDE_LOGIN_URL_FILE";
  var CLAUDE_LOGIN_BROWSER_SCRIPT = "claude-login-browser.sh";

  function claudeLoginOptions(options) {
    options = optionsWithRequestFallbacks(options || {});
    var copy = {};
    for (var key in options) {
      if (Object.prototype.hasOwnProperty.call(options, key)) {
        copy[key] = options[key];
      }
    }
    copy.claudeHome = "";
    copy.agentHome = "";
    copy.claudeHomeScope = "user";
    copy.homeScope = "user";
    copy.userId = trim(options.userId) || contextUserId() || "studio";
    return copy;
  }

  function claudeLoginKey(homePath) {
    return "claude-login:" + filePath(new File(homePath));
  }

  function ensureClaudeLoginBrowserScript(installDir) {
    if (isWindows()) {
      return "";
    }
    var script = new File(installDir, CLAUDE_LOGIN_BROWSER_SCRIPT);
    var source = [
      "#!/bin/sh",
      "# Generated by lib_ConvertigoAgentBridge: records the Claude sign-in URL instead of opening a browser.",
      "if [ -n \"$" + CLAUDE_LOGIN_URL_FILE_ENV + "\" ]; then",
      "  printf '%s\\n' \"$1\" >> \"$" + CLAUDE_LOGIN_URL_FILE_ENV + "\"",
      "fi",
      "exit 0",
      ""
    ].join("\n");
    var current = "";
    try { current = script.isFile() ? readTextFile(script) : ""; } catch (_ignoreClaudeBrowserScriptRead) {}
    if (current !== source) {
      ensureDirectory(script.getParentFile());
      writeTextFile(script, source);
    }
    try { script.setExecutable(true, false); } catch (_ignoreClaudeBrowserScriptExec) {}
    return filePath(script);
  }

  function claudeLoginCapturedUrl(entry) {
    try {
      if (trim(entry.urlFile).length && new File(entry.urlFile).isFile()) {
        var lines = readTextFile(new File(entry.urlFile)).split(/\r?\n/);
        for (var i = lines.length - 1; i >= 0; i--) {
          var line = trim(lines[i]);
          if (line.indexOf("http") === 0) {
            return line;
          }
        }
      }
    } catch (_ignoreClaudeLoginUrl) {}
    return "";
  }

  function publicClaudeLogin(entry, options) {
    var timedOut = expireLoginProcess(entry, AGENT_LOGIN_TIMEOUT_MS);
    var output = loginProcessOutput(entry);
    var alive = processAlive(entry.process);
    var exitCode = loginProcessExitCode(entry, alive);
    var authentication = null;
    if (!alive) {
      if (!entry.authentication) {
        // The CLI is the source of truth once the login process has exited.
        entry.authentication = claudeDoctorAuthentication(options, entry.home, entry.commandPath, true);
      }
      authentication = entry.authentication;
    }
    var authenticated = authentication !== null && authentication.configured === true;
    var error = "";
    if (!alive && !authenticated) {
      error = timedOut ? "Claude browser sign-in timed out." : (trim(output).length ? trim(output) : ("Claude sign-in exited with code " + exitCode));
    }
    return {
      ok: alive || authenticated,
      status: alive ? "waiting_for_login" : (authenticated ? "authenticated" : "error"),
      running: alive,
      authenticated: authenticated,
      home: entry.home,
      verificationUrl: claudeLoginCapturedUrl(entry),
      manualUrl: loginProcessUrl(output),
      message: alive ? "Waiting for Claude browser authentication." : (authenticated ? "Claude authentication completed." : "Claude authentication did not complete."),
      error: error,
      exitCode: exitCode,
      startedAt: Number(entry.startedAt || 0),
      timestamp: now()
    };
  }

  function claudeLoginRuntime(loginOptions) {
    var setup = detectClaudeRuntimePresence(loginOptions);
    if (!setup.claude || setup.claude.found !== true) {
      return { ok: false, setup: setup, error: "Managed Claude Code runtime is not available." };
    }
    if (!trim(setup.claudeHome).length) {
      return { ok: false, setup: setup, error: setup.home && setup.home.error ? setup.home.error : "Managed CLAUDE_CONFIG_DIR is not available." };
    }
    return { ok: true, setup: setup };
  }

  C8O.agentBridge.claudeLoginStatus = function (options) {
    var loginOptions = claudeLoginOptions(options);
    var runtime = claudeLoginRuntime(loginOptions);
    if (!runtime.ok) {
      return { ok: false, status: "missing", error: runtime.error, timestamp: now() };
    }
    var setup = runtime.setup;
    var entry = providerLoginRegistry().get(claudeLoginKey(setup.claudeHome));
    if (entry === null || typeof entry === "undefined") {
      var authentication = inspectClaudeAuthentication(setup.claudeHome);
      return {
        ok: authentication.configured === true,
        status: authentication.configured === true ? "authenticated" : "login_required",
        running: false,
        authenticated: authentication.configured === true,
        authentication: authentication,
        timestamp: now()
      };
    }
    var status = publicClaudeLogin(entry, loginOptions);
    if (status.authenticated === true) {
      bootstrapClaudeHome(loginOptions, setup.claudeHome, setup.mcpEndpoint);
      status.authentication = inspectClaudeAuthentication(setup.claudeHome);
    }
    return status;
  };

  C8O.agentBridge.claudeLoginStart = function (options) {
    var loginOptions = claudeLoginOptions(options);
    var runtime = claudeLoginRuntime(loginOptions);
    if (!runtime.ok) {
      return { ok: false, status: "missing", error: runtime.error, timestamp: now() };
    }
    var setup = runtime.setup;
    var loginBootstrap = bootstrapClaudeHome(loginOptions, setup.claudeHome, setup.mcpEndpoint);
    var key = claudeLoginKey(setup.claudeHome);
    var registry = providerLoginRegistry();
    var existing = registry.get(key);
    if (existing !== null && typeof existing !== "undefined" && processAlive(existing.process)) {
      return publicClaudeLogin(existing, loginOptions);
    }
    var authentication = claudeDoctorAuthentication(loginOptions, setup.claudeHome, setup.claude.path, loginBootstrap.authenticationImported === true);
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
    var urlFile = File.createTempFile("c8o-claude-login-url-", ".txt");
    var stdoutFile = File.createTempFile("c8o-claude-login-out-", ".log");
    var stderrFile = File.createTempFile("c8o-claude-login-err-", ".log");
    var env = claudeRuntimeEnv(loginOptions, setup.claudeHome);
    var browserScript = ensureClaudeLoginBrowserScript(setup.installDir);
    if (browserScript.length) {
      env.BROWSER = browserScript;
      env[CLAUDE_LOGIN_URL_FILE_ENV] = filePath(urlFile);
    }
    var pb = new ProcessBuilder(toJavaList([setup.claude.path, "auth", "login"]));
    applyEngineProxyEnvironment(pb.environment(), "https://claude.com");
    envObjectToMap(pb.environment(), env);
    pb.directory(new File(setup.workspaceRoot));
    pb.redirectOutput(stdoutFile);
    pb.redirectError(stderrFile);
    var entry = {
      provider: "claude",
      process: pb.start(),
      home: setup.claudeHome,
      commandPath: setup.claude.path,
      stdoutFile: stdoutFile,
      stderrFile: stderrFile,
      urlFile: filePath(urlFile),
      startedAt: now()
    };
    registry.put(key, entry);
    return publicClaudeLogin(entry, loginOptions);
  };

  // Managed home -----------------------------------------------------------

  function claudeInstructions(options, profile) {
    var capabilityProfile = agentCapabilityProfile({ agentProfile: profile });
    var isNoCode = capabilityProfile.id === "nocode";
    return [
      "# Convertigo Agent Instructions",
      "",
      "You are Claude Code running inside a Convertigo-integrated local agent session (Tigo).",
      "",
      "- Active authoring policy: `" + capabilityProfile.authoringPolicy + "` (" + capabilityProfile.label + ").",
      isNoCode
        ? "- Automatically follow the Convertigo NoCode workflow for C8Oforms / No-Code Studio work: invoke the `convertigo-nocode` skill before the first no-code operation."
        : "- Invoke the `convertigo-studio` skill first, then the `convertigo-generalist` skill, before the first Convertigo authoring operation of a conversation.",
      "- Use the `" + capabilityProfile.mcpServerName + "` MCP server (tools named `mcp__" + capabilityProfile.mcpServerName + "__*`) whenever you need to inspect, modify, save, reload, or validate Convertigo projects.",
      "- The Convertigo MCP server is the only source of truth for Convertigo projects. If it is unavailable, returns an authorization error (HTTP 401/403), or its tools are missing, stop immediately and report the configuration defect to the user. Never browse the workspace filesystem, project folders, or descriptors as a substitute for MCP.",
      "- When `mobile-builder-open` returns `browserDebugUrl`, `browserDevToolsJsonUrl`, or `browserDevToolsWebSocketUrl`, treat it as the visible Studio mobile viewer and prefer inspecting or driving that viewer over opening a separate browser.",
      "- For viewer automation, use the managed `playwright` MCP server tools (`mcp__playwright__browser_tabs`, `mcp__playwright__browser_snapshot`, `mcp__playwright__browser_click`, `mcp__playwright__browser_evaluate`, ...). They are attached to the Studio JxBrowser viewer over CDP. Do not run ad hoc scripts with `require('playwright')`, raw CDP, or a separate browser.",
      "- Use Playwright only after `mobile-builder-open` reports both `browserDebugPortMatched:true` and `browserControlReady:true`. If the browser target is `about:blank` while builder status is `building`, poll `mobile-builder-open(stateOnly=true, wait=true)` first.",
      "- Studio JxBrowser exposes one existing visible page over CDP, not a normal multi-tab browser. Reuse it and do not create, open, close, select, or navigate tabs/pages.",
      "- If the `playwright` MCP server is unavailable, disabled, still on `about:blank`, or attached to another endpoint after readiness, report the host configuration problem to the user instead of bypassing it; if no viewer automation is configured at all, report the result as implemented but functionally unvalidated.",
      "- If `mobile-builder-open(stateOnly=true)` returns `status:\"stopped\"`, immediately call it once with `stateOnly=false, wait=false`; do not spend a timeout polling an inactive builder.",
      "- If a prompt says Convertigo runtime reveal mode is enabled, pass `reveal:true` only on supported Convertigo mutation/viewer tools; do not add it to read-only calls.",
      isNoCode ? "- You are in the C8Oforms / No-Code Studio surface, not in Eclipse Studio. A selected Convertigo project is optional in this surface." : "- Work on the selected project unless the user explicitly asks for another project.",
      isNoCode ? "" : "- If no project is selected and the user explicitly asks to create a new project or application, derive a concise valid technical name when needed, check for collisions through Convertigo MCP, and proceed without asking for a project selection.",
      "- Prefer Convertigo objects and MCP operations. Do not edit generated folders such as `_private/ionic`, `DisplayObjects`, `dist`, or build outputs.",
      "- Convertigo project descriptors are MCP-owned: never read or edit `c8oProject.yaml`, `_c8oProject/**/*.yaml`, or `project.xml` to implement a project change. If a required Convertigo MCP call still fails after one targeted retry, stop and report the MCP error without changing project files.",
      "- Do not use shell, `rg`, or filesystem scans to rediscover MCP tool signatures already exposed by the MCP schemas and the skills.",
      "- Reply to the user in their language. Keep progress updates short and factual, and never expose hidden reasoning.",
      "- When you change a project, validate the result with the available Convertigo tools before claiming completion.",
      "",
      "Provider: Claude"
    ].filter(function (line) { return line !== ""; }).join("\n");
  }

  function bootstrapClaudeHome(options, homePath, mcpEndpoint) {
    var report = {
      attempted: false,
      ok: true,
      home: trim(homePath),
      copied: [],
      reused: [],
      refreshed: [],
      generated: [],
      authenticationSource: "",
      authenticationImported: false,
      message: "",
      error: ""
    };
    if (!report.home.length) {
      report.message = "Default CLAUDE_CONFIG_DIR selected; bootstrap skipped";
      return report;
    }
    report.attempted = true;
    try {
      var homeDir = new File(report.home);
      ensureDirectory(homeDir);
      syncClaudeCredentials(claudeCredentialSourceDirs(options, homeDir), homeDir, report);
      var stateFile = new File(homeDir, CLAUDE_STATE_FILE);
      var state = readJsonFile(stateFile);
      if (state === null || typeof state !== "object") {
        state = {};
      }
      var stateChanged = false;
      if (state.hasCompletedOnboarding !== true) {
        state.hasCompletedOnboarding = true;
        stateChanged = true;
      }
      if (state.bypassPermissionsModeAccepted !== true) {
        state.bypassPermissionsModeAccepted = true;
        stateChanged = true;
      }
      if (stateChanged) {
        writeJsonFile(stateFile, state);
        report.generated.push(CLAUDE_STATE_FILE);
      } else {
        report.reused.push(CLAUDE_STATE_FILE);
      }
      var capabilityProfile = agentCapabilityProfile(options || {});
      var profileOptions = capabilityProfile.id === "nocode" ? options : copyOptionsWithProfile(options, "generalist");
      var endpoint = capabilityProfile.id === "nocode" ? (trim(mcpEndpoint) || resolveMcpEndpoint(options)) : profileOptions.mcpEndpoint;
      if (writeClaudeMcpConfig(report.home, endpoint, profileOptions)) {
        report.generated.push(CLAUDE_MCP_CONFIG_FILE);
      } else {
        report.reused.push(CLAUDE_MCP_CONFIG_FILE);
      }
      var instructionsWrite = writeManagedTextFile(new File(homeDir, CLAUDE_INSTRUCTIONS_FILE), claudeInstructions(options, capabilityProfile.id), false);
      if (instructionsWrite.status === "unchanged") {
        report.reused.push(CLAUDE_INSTRUCTIONS_FILE);
      } else {
        report.generated.push(CLAUDE_INSTRUCTIONS_FILE);
      }
      report.message = capabilityProfile.id === "nocode" ? "Scoped NoCode CLAUDE_CONFIG_DIR bootstrapped" : "Scoped Studio CLAUDE_CONFIG_DIR bootstrapped";
    } catch (e) {
      report.ok = false;
      report.error = String(e);
      report.message = "Unable to bootstrap scoped CLAUDE_CONFIG_DIR";
    }
    return report;
  }

  function findSetupClaudeResult(value, depth) {
    if (value === null || typeof value === "undefined" || typeof value !== "object" || depth > 8) {
      return null;
    }
    if (Object.prototype.hasOwnProperty.call(value, "skillStatus") &&
        (Object.prototype.hasOwnProperty.call(value, "resolvedClaudeHome") || Object.prototype.hasOwnProperty.call(value, "skillPath"))) {
      return value;
    }
    var preferred = ["setupClaudeResult", "result", "document", "doc", "payload", "response"];
    for (var i = 0; i < preferred.length; i++) {
      if (Object.prototype.hasOwnProperty.call(value, preferred[i])) {
        var found = findSetupClaudeResult(value[preferred[i]], depth + 1);
        if (found !== null) {
          return found;
        }
      }
    }
    for (var key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        var nested = value[key];
        if (nested !== null && typeof nested === "object") {
          var nestedFound = findSetupClaudeResult(nested, depth + 1);
          if (nestedFound !== null) {
            return nestedFound;
          }
        }
      }
    }
    return null;
  }

  function setupClaudeFromMcpProject(options, claudeHome, mcpEndpoint) {
    var report = {
      attempted: false,
      ok: false,
      source: "lib_ConvertigoMCP._setupClaude",
      skillStatus: "",
      resolvedClaudeHome: filePath(claudeHome),
      resolvedMcpUrl: trim(mcpEndpoint) || resolveMcpEndpoint(options),
      skillPath: "",
      warnings: [],
      dryRun: boolValue(options.dryRun, false),
      message: "",
      error: ""
    };
    if (projectDirectoryByName("lib_ConvertigoMCP") === null) {
      report.error = "lib_ConvertigoMCP project not loaded";
      report.message = "lib_ConvertigoMCP project not loaded; using bridge fallback skill generator";
      return report;
    }
    report.attempted = true;
    try {
      var response = callLocalSequence("lib_ConvertigoMCP", "_setupClaude", {
        claudeHome: filePath(claudeHome),
        mcpUrl: report.resolvedMcpUrl,
        configureMcp: "false",
        dryRun: report.dryRun ? "true" : "false"
      });
      var result = findSetupClaudeResult(response, 0);
      if (result === null) {
        throw new Error("lib_ConvertigoMCP._setupClaude did not return a setup result");
      }
      var skillInfo = result.skills && result.skills.generalist ? result.skills.generalist : null;
      report.ok = true;
      report.skillStatus = trim(skillInfo && skillInfo.status) || trim(result.skillStatus) || "unknown";
      report.resolvedClaudeHome = trim(result.resolvedClaudeHome) || report.resolvedClaudeHome;
      report.resolvedMcpUrl = trim(result.resolvedMcpUrl) || report.resolvedMcpUrl;
      report.skillPath = trim(skillInfo && skillInfo.path) || trim(result.skillPath);
      if (result.warnings && typeof result.warnings.length !== "undefined") {
        for (var i = 0; i < result.warnings.length; i++) {
          var warning = trim(result.warnings[i]);
          if (warning.length) {
            report.warnings.push(warning);
          }
        }
      }
      report.message = "Convertigo Generalist skill synchronized from lib_ConvertigoMCP._setupClaude";
    } catch (e) {
      report.ok = false;
      report.error = String(e);
      report.message = "Unable to synchronize from lib_ConvertigoMCP._setupClaude; using bridge fallback skill generator";
    }
    return report;
  }

  function installClaudeSkills(options, homePath) {
    options = options || {};
    var profile = normalizeSkillProfile(options);
    var dryRun = boolValue(options.dryRun, false);
    var report = {
      attempted: false,
      ok: true,
      provider: "claude",
      source: "Convertigo Studio setup",
      target: trim(homePath),
      skillStatus: "skipped",
      routerSkillStatus: "skipped",
      configStatus: "not_applicable",
      resolvedClaudeHome: trim(homePath),
      resolvedMcpUrl: resolveMcpEndpoint(options),
      skillPath: "",
      routerSkillPath: "",
      warnings: [],
      generated: [],
      reused: [],
      copied: [],
      skipped: false,
      message: "",
      error: ""
    };
    if (boolValue(options.skipSkillsInstall || options.skipSkillSync, false)) {
      report.skipped = true;
      report.message = "Skill synchronization disabled by request";
      report.bundle = managedSkillBundleState(options, homePath, "claude");
      return report;
    }
    if (!trim(homePath).length) {
      report.skipped = true;
      report.message = "Using the default Claude home; skill synchronization skipped";
      report.bundle = managedSkillBundleState(options, homePath, "claude");
      return report;
    }
    report.attempted = true;
    try {
      var homeDir = new File(homePath);
      ensureDirectory(homeDir);
      if (profile === "nocode") {
        var noCodeSkillFile = new File(new File(new File(homeDir, "skills"), "convertigo-nocode"), "SKILL.md");
        var noCodeSkill = managedSkillContent(options, profile, report.resolvedMcpUrl);
        var noCodeWrite = writeManagedTextFile(noCodeSkillFile, noCodeSkill.content, dryRun);
        report.skillStatus = noCodeWrite.status;
        report.skillPath = filePath(noCodeSkillFile);
        (noCodeWrite.status === "unchanged" ? report.reused : (noCodeSkill.copied === true ? report.copied : report.generated)).push("skills/convertigo-nocode/SKILL.md");
        report.message = "Convertigo NoCode skill configured";
      } else {
        var generalistOptions = copyOptionsWithProfile(options, "generalist");
        var skillFile = new File(new File(new File(homeDir, "skills"), "convertigo-generalist"), "SKILL.md");
        var delegated = setupClaudeFromMcpProject(generalistOptions, homeDir, generalistOptions.mcpEndpoint);
        if (delegated.attempted === true && delegated.ok === true) {
          report.skillStatus = delegated.skillStatus;
          report.skillPath = delegated.skillPath || filePath(skillFile);
          report.source = delegated.source;
          report.warnings = report.warnings.concat(delegated.warnings || []);
          report.message = delegated.message;
        } else {
          if (delegated.message) {
            report.warnings.push(delegated.message + (delegated.error ? ": " + delegated.error : ""));
          }
          var skillSource = managedSkillContent(generalistOptions, "generalist", generalistOptions.mcpEndpoint);
          var skillWrite = writeManagedTextFile(skillFile, skillSource.content, dryRun);
          report.skillStatus = skillWrite.status;
          report.skillPath = filePath(skillFile);
          report.message = "Convertigo Generalist skill configured";
        }
        (report.skillStatus === "unchanged" ? report.reused : report.generated).push("skills/convertigo-generalist/SKILL.md");
        var router = installStudioRouterSkill(homePath, dryRun, true);
        report.routerSkillStatus = router.status;
        report.routerSkillPath = router.path;
        (router.status === "unchanged" ? report.reused : report.generated).push("skills/" + STUDIO_ROUTER_SKILL_SLUG + "/SKILL.md");
        var noCodeRemoval = removeStudioNoCodeSkill(homePath, dryRun);
        if (noCodeRemoval.status === "removed" || noCodeRemoval.status === "would-remove") {
          report.removed = ["skills/convertigo-nocode"];
        }
        if (noCodeRemoval.status === "error") {
          report.ok = false;
          report.warnings.push("Unable to remove the NoCode skill from the Studio home: " + JSON.stringify(noCodeRemoval.errors));
        }
      }
    } catch (e) {
      report.ok = false;
      report.error = String(e);
      report.message = "Unable to configure Claude skills";
    }
    report.bundle = managedSkillBundleState(options, homePath, "claude");
    return report;
  }

  // Setup and settings -----------------------------------------------------

  C8O.agentBridge.claudeSetup = function (options) {
    options = optionsWithRequestFallbacks(options || {});
    if (boolValue(options.loginStatus || options.claudeLoginStatus, false)) {
      return C8O.agentBridge.claudeLoginStatus(options);
    }
    if (boolValue(options.login || options.claudeLogin, false)) {
      return C8O.agentBridge.claudeLoginStart(options);
    }
    var install = boolValue(options.install || options.installClaude, false);
    var installation = { attempted: false, installed: false, reused: false, method: "", package: "", steps: [] };
    var messages = [];
    var startupPresenceOnly = boolValue(options.startupPresenceOnly, false);
    var emptyBootstrap = function () {
      return { attempted: false, ok: true, home: "", copied: [], reused: [], generated: [], message: "", error: "" };
    };
    var finish = function (setup, bootstrap, skills, forceAuthCheck, presence) {
      var capabilityProfile = agentCapabilityProfile(options);
      var mcpReady = setup.mcp.hasManagedServer === true;
      if (setup.claude.found && !mcpReady) {
        messages.push("Claude Code does not list the Convertigo " + capabilityProfile.mcpServerName + " MCP server after setup.");
      }
      if (setup.claude.found && claudePlaywrightEnabled(options) && !(setup.playwright && (setup.playwright.installed === true || setup.playwright.found === true))) {
        messages.push("Playwright MCP is not available in the managed Claude runtime; Studio viewer automation stays disabled.");
      }
      var authentication = presence
        ? claudeDoctorAuthentication(options, setup.claudeHome || setup.home.path, "", false)
        : claudeDoctorAuthentication(options, setup.claudeHome || setup.home.path, setup.claude.path, forceAuthCheck === true);
      var runtimeReady = setup.claude.found && !setup.home.error.length && skills.ok === true && mcpReady;
      var ready = runtimeReady && authentication.configured === true;
      if (runtimeReady && !ready) {
        messages.push("Claude authentication is required. Run `claude auth login` (or `claude setup-token`) on this workstation, then retry.");
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
        startupPresenceOnly: presence === true,
        timestamp: now()
      };
    };
    if (!install && startupPresenceOnly) {
      var presenceSetup = detectClaudeRuntimePresence(options);
      var presenceBootstrap = emptyBootstrap();
      if (presenceSetup.home.error) {
        messages.push(presenceSetup.home.error);
      }
      if (presenceSetup.claude.found === true && claudePlaywrightEnabled(options) && presenceSetup.playwright.installed !== true
          && commandPathStartsWith(presenceSetup.claude, presenceSetup.installDir) && !boolValue(options.skipPlaywrightInstall || options.skipClaudePlaywrightInstall, false)) {
        var lazyPlaywright = ensureClaudePlaywrightRuntime(options, presenceSetup.installDir, presenceSetup.claude);
        if (lazyPlaywright.error) {
          messages.push(String(lazyPlaywright.error));
        }
      }
      if (presenceSetup.claude.found === true && presenceSetup.home.path.length && !presenceSetup.home.error.length) {
        presenceBootstrap = bootstrapClaudeHome(options, presenceSetup.home.path, presenceSetup.mcpEndpoint);
        if (presenceBootstrap.message) {
          messages.push(presenceBootstrap.message);
        }
        if (presenceBootstrap.error) {
          messages.push(presenceBootstrap.error);
        }
      }
      var presenceSkills = installAgentSkills(options, "claude", presenceSetup.claudeHome || presenceSetup.home.path);
      if (presenceSkills.message) {
        messages.push(presenceSkills.message);
      }
      if (presenceSkills.error) {
        messages.push(presenceSkills.error);
      }
      presenceSetup = detectClaudeRuntimePresence(options);
      return finish(presenceSetup, presenceBootstrap, presenceSkills, false, true);
    }
    if (install) {
      try {
        installation = ensureClaudeRuntime(options);
      } catch (e) {
        messages.push(String(e));
        return {
          ok: false,
          status: "error",
          phase: "claude_setup",
          error: String(e),
          setup: detectClaudeRuntime(options),
          installation: installation,
          messages: messages,
          timestamp: now()
        };
      }
    }
    var setup = detectClaudeRuntime(options);
    var bootstrap = emptyBootstrap();
    if (setup.home.error) {
      messages.push(setup.home.error);
    }
    if (setup.home.path.length && !setup.home.error.length) {
      bootstrap = bootstrapClaudeHome(options, setup.home.path, setup.mcpEndpoint);
      if (bootstrap.message) {
        messages.push(bootstrap.message);
      }
      if (bootstrap.error) {
        messages.push(bootstrap.error);
      }
    }
    var skills = installAgentSkills(options, "claude", setup.claudeHome || setup.home.path);
    if (skills.message) {
      messages.push(skills.message);
    }
    if (skills.error) {
      messages.push(skills.error);
    }
    setup = detectClaudeRuntime(options);
    return finish(setup, bootstrap, skills, bootstrap.authenticationImported === true || boolValue(options.forceAuthCheck, false), false);
  };

  function claudeModelCatalog() {
    var models = [];
    var levels = [];
    for (var i = 0; i < CLAUDE_EFFORT_LEVELS.length; i++) {
      levels.push({
        id: CLAUDE_EFFORT_LEVELS[i],
        label: CLAUDE_EFFORT_LEVELS[i] === "max" ? "Max" : (codexReasoningLabel(CLAUDE_EFFORT_LEVELS[i]) || CLAUDE_EFFORT_LEVELS[i]),
        description: "Claude Code effort level"
      });
    }
    for (var m = 0; m < CLAUDE_MODEL_CATALOG.length; m++) {
      var item = CLAUDE_MODEL_CATALOG[m];
      models.push({
        id: item.id,
        label: item.label,
        description: item.description,
        defaultReasoning: item.defaultReasoning,
        reasoningLevels: levels.slice(0),
        serviceTiers: [],
        speedTiers: [],
        priority: item.priority
      });
    }
    return models;
  }

  function claudeSettings(options) {
    options = optionsWithRequestFallbacks(options);
    var capabilityProfile = publicAgentCapabilityProfile(options);
    var presenceOnly = boolValue(options.runtimePresenceOnly, false);
    var setup = presenceOnly ? detectClaudeRuntimePresence(options) : detectClaudeRuntime(options);
    var runtime = runtimeUpdateStatus("claude", setup.claude, claudeLatestVersion(options, setup), "npm");
    var bootstrap = null;
    var skills = null;
    if (setup.claude.found && !presenceOnly && trim(setup.claudeHome).length) {
      try {
        bootstrap = bootstrapClaudeHome(options, setup.claudeHome, resolveMcpEndpoint(options));
        skills = installAgentSkills(options, "claude", setup.claudeHome);
        setup = detectClaudeRuntime(options);
      } catch (_ignoreClaudeHomePrepare) {}
    }
    var models = claudeModelCatalog();
    var profileSupported = capabilityProfile.supportedProviders.indexOf("claude") >= 0;
    return {
      id: "claude",
      label: "Claude",
      status: profileSupported ? (setup.claude.found ? "ready" : "missing") : "unsupported_profile",
      ready: profileSupported && setup.claude.found === true,
      runtime: runtime,
      authentication: presenceOnly
        ? inspectClaudeAuthentication(setup.claudeHome)
        : claudeDoctorAuthentication(options, setup.claudeHome, setup.claude.path, bootstrap && bootstrap.authenticationImported === true),
      setup: compactClaudeSetup(setup),
      bootstrap: bootstrap,
      skills: skills,
      source: {
        type: "catalog",
        command: String(setup.claude.path || ""),
        ok: true,
        exitCode: 0,
        error: "",
        stderr: ""
      },
      defaultModel: models.length ? models[0].id : "",
      models: models,
      reasoningMode: "per_model",
      profileSupported: profileSupported,
      supports: {
        resume: true,
        stop: true,
        images: false,
        mcp: setup.mcp.hasManagedServer === true,
        reasoning: true,
        serviceTier: false
      },
      agentProfile: capabilityProfile
    };
  }

  // Resident process ---------------------------------------------------------

  function normalizeClaudeEffort(value) {
    var effort = trim(value).toLowerCase();
    if (!effort.length || effort === "default" || effort === "auto") {
      return "";
    }
    if (effort === "very-high" || effort === "very_high" || effort === "extra-high" || effort === "extra_high") {
      return "xhigh";
    }
    return CLAUDE_EFFORT_LEVELS.indexOf(effort) >= 0 ? effort : "";
  }

  function claudeCommand(entry, options) {
    var command = parseCommand(options.claudeCommand, [entry.claudePath || "claude"]);
    if (command.length === 1) {
      command.push("-p");
      command.push("--input-format");
      command.push("stream-json");
      command.push("--output-format");
      command.push("stream-json");
      command.push("--verbose");
      command.push("--include-partial-messages");
      command.push("--permission-mode");
      command.push("bypassPermissions");
      command.push("--dangerously-skip-permissions");
      if (trim(entry.mcpConfigFile).length) {
        command.push("--mcp-config");
        command.push(entry.mcpConfigFile);
        command.push("--strict-mcp-config");
      }
      if (trim(entry.model).length && trim(entry.model).toLowerCase() !== "default") {
        command.push("--model");
        command.push(trim(entry.model));
      }
      if (trim(entry.reasoningEffort).length) {
        command.push("--effort");
        command.push(trim(entry.reasoningEffort));
      }
      if (trim(entry.sessionId).length) {
        command.push("--resume");
        command.push(trim(entry.sessionId));
      }
      if (trim(entry.workspaceRoot).length && trim(entry.cwd) !== trim(entry.workspaceRoot)) {
        command.push("--add-dir");
        command.push(trim(entry.workspaceRoot));
      }
    }
    return command;
  }

  function claudeStartOptions(options) {
    return {
      workspaceRoot: options.workspaceRoot,
      installDir: options.installDir,
      claudeHome: options.claudeHome || options.agentHome,
      claudeHomeScope: options.claudeHomeScope || options.homeScope || options.scope,
      userId: options.userId,
      conversationId: options.conversationId,
      projectId: options.projectId,
      agentProfile: options.agentProfile,
      skillProfile: options.skillProfile,
      assistantContext: options.assistantContext,
      assistantSurface: options.assistantSurface,
      mcpEndpoint: options.mcpEndpoint,
      claudePath: options.claudePath || options.commandPath,
      install: options.install || options.installClaude,
      nodeVersion: options.nodeVersion,
      nodeDir: options.nodeDir || options.nodeInstallDir,
      npmPath: options.npmPath,
      allowNodeDownload: options.allowNodeDownload,
      claudePackage: options.claudePackage || options.packageName,
      claudeVersion: options.claudeVersion || options.packageVersion,
      claudeInstallMethod: options.claudeInstallMethod || options.installMethod,
      claudeInstallTimeoutMs: options.claudeInstallTimeoutMs,
      forceClaudeInstall: options.forceClaudeInstall || options.forceInstall,
      viewerDebugPort: options.viewerDebugPort,
      browserDebugUrl: options.browserDebugUrl,
      browserDevToolsJsonUrl: options.browserDevToolsJsonUrl,
      browserDevToolsWebSocketUrl: options.browserDevToolsWebSocketUrl,
      playwrightCdpEndpoint: options.playwrightCdpEndpoint || options.viewerCdpEndpoint,
      playwrightMcpEndpoint: options.playwrightMcpEndpoint,
      skipPlaywrightInstall: options.skipPlaywrightInstall || options.skipClaudePlaywrightInstall,
      forcePlaywrightInstall: options.forcePlaywrightInstall || options.forceClaudePlaywrightInstall,
      agentRevealMode: firstDefinedOption(options, ["agentRevealMode", "convertigoRevealMode", "uiRevealMode", "revealMode", "reveal"]),
      mcpSkillsSourceDir: options.mcpSkillsSourceDir || options.skillsSourceDir || options.convertigoMcpDir,
      skipSkillsInstall: options.skipSkillsInstall || options.skipSkillSync,
      nocodeMcpTokenHandle: options.nocodeMcpTokenHandle || options.noCodeMcpTokenHandle || options.mcpBearerTokenHandle,
      noCodeMcpTokenHandle: options.noCodeMcpTokenHandle,
      mcpBearerTokenHandle: options.mcpBearerTokenHandle,
      mcpBearerToken: options.mcpBearerToken,
      nocodeMcpToken: options.nocodeMcpToken || options.noCodeMcpToken,
      startupPresenceOnly: true
    };
  }

  C8O.agentBridge.claudeStart = function (options) {
    var operationStartedAt = now();
    options = optionsWithRequestFallbacks(options || {});
    try {
      C8O.agentBridge.sweepExpired({});
    } catch (_ignoreStartSweep) {}
    try {
      ensureManagedViewerDebugPort(options);
    } catch (viewerDebugPortError) {
      return { ok: false, status: "error", phase: "viewer_debug_port", error: String(viewerDebugPortError), timestamp: now() };
    }
    if (intValue(options.viewerDebugPort, 0, 0, 65535) >= 1024) {
      options.claudeHome = "";
      options.agentHome = "";
      options.claudeHomeScope = "conversation";
      options.homeScope = "conversation";
    }
    var handle = trim(options.handle) || makeHandle("claude");
    var registry = getRegistry();
    var existing = registry.get(handle);
    var requestedModel = trim(options.model || options.agentModel);
    var requestedEffort = normalizeClaudeEffort(options.reasoningEffort || options.reasoningLevel || options.modelReasoningEffort);
    if (existing !== null && typeof existing !== "undefined" && processAlive(existing.process)) {
      var requestedMcpTokenFingerprint = mcpBearerTokenFingerprint(options);
      var mcpTokenChanged = requestedMcpTokenFingerprint.length && trim(existing.mcpBearerTokenFingerprint) !== requestedMcpTokenFingerprint;
      var revealModeChanged = revealModeEnabled(options, existing) !== (existing.convertigoRevealMode === true);
      var modelChanged = requestedModel.length && requestedModel !== trim(existing.model);
      var effortChanged = trim(options.reasoningEffort || options.reasoningLevel || options.modelReasoningEffort).length && requestedEffort !== trim(existing.reasoningEffort);
      var requestedPlaywrightCdpEndpoint = resolvePlaywrightMcpCdpEndpoint(options);
      var activePlaywrightCdpEndpoint = trim(existing.playwrightCdpEndpoint || existing.viewerCdpEndpoint);
      var viewerChanged = requestedPlaywrightCdpEndpoint.length && activePlaywrightCdpEndpoint !== requestedPlaywrightCdpEndpoint;
      if (mcpTokenChanged || revealModeChanged || modelChanged || effortChanged || viewerChanged) {
        pushEvent(existing, "warning", {
          message: mcpTokenChanged
            ? "Claude Code must restart to renew its managed Convertigo MCP authorization."
            : (revealModeChanged ? "Claude Code must restart to update Convertigo reveal mode."
              : (viewerChanged ? "Claude Code must restart to refresh the managed Playwright MCP viewer endpoint." : "Claude Code must restart to apply the requested model or effort.")),
          provider: "claude",
          reason: mcpTokenChanged ? "mcp_token_renewed" : (revealModeChanged ? "reveal_mode_changed" : (viewerChanged ? "playwright_endpoint_changed" : "model_changed")),
          previousEndpoint: activePlaywrightCdpEndpoint,
          requestedEndpoint: requestedPlaywrightCdpEndpoint
        });
        if (!trim(options.claudeSessionId || options.sessionId || options.externalSessionId).length && trim(existing.sessionId).length) {
          options.sessionId = existing.sessionId;
        }
        stopEntry(existing, true);
        existing = null;
      } else {
        writeEntryPidFile(existing);
        rememberSessionHandle(handle);
        return {
          ok: true,
          status: "already_running",
          handle: handle,
          sessionId: existing.sessionId,
          claudeSessionId: existing.sessionId,
          timings: { acceptedAt: operationStartedAt, processReused: true, totalMs: now() - operationStartedAt },
          state: statusOf(existing),
          timestamp: now()
        };
      }
    }

    var setupStartedAt = now();
    var setup = C8O.agentBridge.claudeSetup(claudeStartOptions(options));
    var setupCompletedAt = now();
    if (!setup.ok) {
      var authenticationRequired = setup.status === "authentication_required";
      var setupError = "claude CLI is required before start";
      if (setup.setup && setup.setup.claude && setup.setup.claude.found === true) {
        if (setup.setup.mcp && setup.setup.mcp.ok !== true) {
          setupError = "Claude MCP configuration is not usable" + (trim(setup.setup.mcp.error).length ? ": " + trim(setup.setup.mcp.error) : "");
        } else if (setup.messages && setup.messages.length) {
          setupError = String(setup.messages[setup.messages.length - 1]);
        } else {
          setupError = "Claude local setup is incomplete";
        }
      }
      return {
        ok: false,
        status: authenticationRequired ? "authentication_required" : "error",
        phase: "setup",
        error: authenticationRequired ? "Claude authentication is required before start" : setupError,
        setup: setup,
        timestamp: now()
      };
    }

    var env = claudeRuntimeEnv(options, setup.setup.claudeHome);
    var extraEnv = parseObject(options.env, {});
    for (var envKey in extraEnv) {
      if (Object.prototype.hasOwnProperty.call(extraEnv, envKey)) {
        env[envKey] = extraEnv[envKey];
      }
    }
    env.TERM = env.TERM || "xterm-256color";
    var cwd = normalizeDirectory(options.cwd, setup.setup.workspaceRoot, setup.setup.workspaceRoot);
    var ttlMillis = intValue(options.ttlSeconds, DEFAULT_TTL_SECONDS, 30, 86400) * 1000;
    var orphanSweep = sweepProviderPidFiles(setup.setup.workspaceRoot, "claude", ttlMillis);
    var credentials = {
      policy: setup.setup.home && setup.setup.home.path ? "scoped-home" : "default-home",
      sources: setup.bootstrap && setup.bootstrap.authenticationSource ? [setup.bootstrap.authenticationSource] : [],
      injectedKeys: []
    };
    var entry = createEntry(handle, "claude", CLAUDE_PROTOCOL, [], cwd, env, ttlMillis, setup.setup.home, credentials, requestedModel);
    entry.workspaceRoot = setup.setup.workspaceRoot;
    entry.pidFile = "";
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
    entry.mcpConfigFile = setup.setup.mcp && setup.setup.mcp.path ? setup.setup.mcp.path : "";
    entry.viewerDebugPort = intValue(options.viewerDebugPort, 0, 0, 65535);
    entry.browserDebugUrl = trim(options.browserDebugUrl);
    entry.browserDevToolsJsonUrl = trim(options.browserDevToolsJsonUrl);
    entry.browserDevToolsWebSocketUrl = trim(options.browserDevToolsWebSocketUrl);
    entry.playwrightCdpEndpoint = resolvePlaywrightMcpCdpEndpoint(options);
    entry.viewerCdpEndpoint = trim(options.viewerCdpEndpoint || entry.playwrightCdpEndpoint);
    entry.playwrightMcpEndpoint = trim(options.playwrightMcpEndpoint);
    entry.playwrightMcpEnabled = !!(setup.setup.mcp && setup.setup.mcp.hasPlaywright === true);
    entry.convertigoRevealMode = revealModeEnabled(options, null);
    entry.reasoningEffort = requestedEffort;
    entry.claudePath = setup.setup.claude.path || "claude";
    entry.sessionId = trim(options.claudeSessionId || options.sessionId || options.externalSessionId);
    entry.claudeResumedSessionId = entry.sessionId;
    entry.claudeTurnEnded = false;
    entry.claudeStreamState = {};
    entry.claudeToolCalls = {};
    entry.claudeSeenMessages = {};
    entry.managedSkillBundle = setup.skills && setup.skills.bundle
      ? setup.skills.bundle
      : managedSkillBundleState(options, setup.setup.claudeHome || (setup.setup.home && setup.setup.home.path), "claude");
    entry.managedSkillBundleFingerprint = trim(entry.managedSkillBundle && entry.managedSkillBundle.fingerprint);
    registry.put(handle, entry);

    try {
      entry.command = claudeCommand(entry, options);
      entry.envKeys = envKeys(env);
      startProcess(entry, env);
      entry.status = "running";
      entry.phase = "ready";
      pushEvent(entry, "system/start", {
        handle: handle,
        provider: "claude",
        protocol: CLAUDE_PROTOCOL,
        command: entry.command,
        cwd: cwd,
        claudeHome: setup.setup.claudeHome,
        home: publicHomeInfo(setup.setup.home),
        resumedSessionId: entry.sessionId,
        mcp: setup.setup.mcp,
        viewerDebugPort: entry.viewerDebugPort,
        playwrightCdpEndpoint: entry.playwrightCdpEndpoint,
        playwrightMcpEnabled: entry.playwrightMcpEnabled === true,
        model: entry.model,
        reasoningEffort: entry.reasoningEffort
      });
      rememberSessionHandle(handle);
    } catch (startError) {
      entry.status = "error";
      entry.phase = "error";
      entry.lastError = String(startError);
      pushEvent(entry, "error", { message: String(startError), phase: "claude_start", provider: "claude" });
      stopEntry(entry, false);
      return {
        ok: false,
        status: "error",
        phase: "claude_start",
        error: String(startError),
        handle: handle,
        state: statusOf(entry),
        setup: setup,
        timestamp: now()
      };
    }
    if (orphanSweep.stopped.length) {
      pushEvent(entry, "system/sweep", { provider: "claude", stopped: orphanSweep.stopped });
    }
    return {
      ok: true,
      status: "started",
      handle: handle,
      sessionId: entry.sessionId,
      claudeSessionId: entry.sessionId,
      cursor: entry.nextIndex,
      timings: {
        acceptedAt: operationStartedAt,
        setupStartedAt: setupStartedAt,
        setupCompletedAt: setupCompletedAt,
        setupMs: setupCompletedAt - setupStartedAt,
        processReused: false,
        totalMs: now() - operationStartedAt
      },
      state: statusOf(entry),
      setup: setup,
      timestamp: now()
    };
  };

  function claudeRestartOptions(entry, options, handle, promptText) {
    var restartOptions = {};
    for (var key in options) {
      if (Object.prototype.hasOwnProperty.call(options, key)) {
        restartOptions[key] = options[key];
      }
    }
    restartOptions.handle = handle;
    restartOptions.prompt = promptText;
    restartOptions.claudeHome = entry.home && entry.home.path ? entry.home.path : "";
    restartOptions.workspaceRoot = entry.workspaceRoot;
    restartOptions.cwd = entry.cwd;
    restartOptions.claudePath = entry.claudePath;
    restartOptions.sessionId = entry.sessionId;
    restartOptions.claudeSessionId = entry.sessionId;
    restartOptions.model = entry.model;
    restartOptions.reasoningEffort = entry.reasoningEffort;
    restartOptions.viewerDebugPort = entry.viewerDebugPort;
    restartOptions.browserDebugUrl = entry.browserDebugUrl;
    restartOptions.browserDevToolsJsonUrl = entry.browserDevToolsJsonUrl;
    restartOptions.browserDevToolsWebSocketUrl = entry.browserDevToolsWebSocketUrl;
    restartOptions.playwrightCdpEndpoint = entry.playwrightCdpEndpoint;
    restartOptions.playwrightMcpEndpoint = entry.playwrightMcpEndpoint;
    restartOptions.userId = entry.userId;
    restartOptions.conversationId = entry.conversationId;
    restartOptions.projectId = entry.projectId;
    restartOptions.agentProfile = entry.agentProfile || entry.skillProfile;
    restartOptions.skillProfile = entry.skillProfile;
    restartOptions.assistantContext = entry.assistantContext;
    restartOptions.assistantSurface = entry.assistantSurface;
    restartOptions.mcpEndpoint = entry.mcpEndpoint;
    restartOptions.mcpBearerTokenHandle = entry.mcpBearerTokenHandle;
    restartOptions.nocodeMcpTokenHandle = entry.nocodeMcpTokenHandle;
    restartOptions.agentRevealMode = entry.convertigoRevealMode === true ? "true" : "false";
    restartOptions.ttlSeconds = Math.max(30, Math.floor(entry.ttlMillis / 1000));
    return restartOptions;
  }

  C8O.agentBridge.claudePrompt = function (options) {
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
    if (!processAlive(entry.process)) {
      return { ok: false, status: "not_running", handle: handle, state: statusOf(entry), timestamp: now() };
    }
    var promptText = String(options.prompt || "");
    if (!trim(promptText).length) {
      return { ok: false, status: "error", handle: handle, error: "prompt is required", timestamp: now() };
    }
    var requestedSession = trim(options.claudeSessionId || options.sessionId || options.externalSessionId);
    if (requestedSession.length && !trim(entry.sessionId).length) {
      entry.sessionId = requestedSession;
    }
    var requestedModel = trim(options.model || options.agentModel);
    var requestedEffortRaw = trim(options.reasoningEffort || options.reasoningLevel || options.modelReasoningEffort);
    var requestedEffort = normalizeClaudeEffort(requestedEffortRaw);
    var restartReason = "";
    if (intValue(options.viewerDebugPort, 0, 0, 65535) < 1024 && Number(entry.viewerDebugPort || 0) >= 1024) {
      options.viewerDebugPort = entry.viewerDebugPort;
    }
    var requestedPlaywrightCdpEndpoint = resolvePlaywrightMcpCdpEndpoint(options);
    if (requestedPlaywrightCdpEndpoint.length) {
      var activePlaywrightCdpEndpoint = trim(entry.playwrightCdpEndpoint || entry.viewerCdpEndpoint);
      if (activePlaywrightCdpEndpoint !== requestedPlaywrightCdpEndpoint) {
        restartReason = "playwright_endpoint_changed";
      }
      entry.browserDebugUrl = trim(options.browserDebugUrl || entry.browserDebugUrl);
      entry.browserDevToolsJsonUrl = trim(options.browserDevToolsJsonUrl || entry.browserDevToolsJsonUrl);
      entry.browserDevToolsWebSocketUrl = trim(options.browserDevToolsWebSocketUrl || entry.browserDevToolsWebSocketUrl);
    }
    if (requestedModel.length && requestedModel !== trim(entry.model)) {
      restartReason = "model_changed";
    } else if (requestedEffortRaw.length && requestedEffort !== trim(entry.reasoningEffort)) {
      restartReason = "effort_changed";
    }
    entry.convertigoRevealMode = revealModeEnabled(options, entry);
    try {
      if (entry.home && trim(entry.home.path).length) {
        var latestSkillBundle = managedSkillBundleState(options, entry.home.path, "claude");
        var previousFingerprint = trim(entry.managedSkillBundleFingerprint);
        if (previousFingerprint.length && trim(latestSkillBundle.fingerprint).length && previousFingerprint !== latestSkillBundle.fingerprint) {
          restartReason = restartReason || "skill_bundle_changed";
        }
        entry.managedSkillBundle = latestSkillBundle;
        entry.managedSkillBundleFingerprint = trim(latestSkillBundle.fingerprint);
      }
    } catch (refreshError) {
      pushEvent(entry, "warning", { message: String(refreshError), provider: "claude" });
    }
    if (restartReason.length) {
      pushEvent(entry, "warning", {
        message: "Claude Code restarts before the next turn (" + restartReason + ").",
        provider: "claude",
        reason: restartReason
      });
      if (requestedModel.length) {
        entry.model = requestedModel;
      }
      if (requestedEffortRaw.length) {
        entry.reasoningEffort = requestedEffort;
      }
      var restartOptions = claudeRestartOptions(entry, options, handle, promptText);
      stopEntry(entry, true);
      var restarted = C8O.agentBridge.claudeStart(restartOptions);
      if (!restarted.ok && /no conversation found|session.*not found/i.test(String(restarted.error || ""))) {
        restartOptions.sessionId = "";
        restartOptions.claudeSessionId = "";
        restarted = C8O.agentBridge.claudeStart(restartOptions);
      }
      if (!restarted.ok) {
        return {
          ok: false,
          status: "error",
          phase: "claude_restart",
          handle: handle,
          error: restarted.error || "Unable to restart Claude Code before the next turn.",
          setup: restarted.setup || null,
          timestamp: now()
        };
      }
      return C8O.agentBridge.claudePrompt(restartOptions);
    }
    var managedPreflightCurrent = entry.home && trim(entry.home.path).length > 0;
    if (managedPreflightCurrent) {
      promptText = withManagedGuidancePreflight(promptText, {
        mcpEndpoint: entry.mcpEndpoint,
        skillBundle: entry.managedSkillBundle
      });
    }
    promptText = withRevealModePrompt(promptText, entry.convertigoRevealMode === true);
    var cursor = entry.nextIndex;
    var requestId = entry.nextRequestId++;
    entry.status = "running";
    entry.phase = "turn";
    entry.claudeTurnEnded = false;
    entry.claudeStreamState = {};
    entry.claudeSeenMessages = {};
    entry.claudePendingNarration = "";
    entry.lastCodexProgressMessage = "";
    entry.lastCodexAnswerChunk = "";
    try {
      writeJson(entry, {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: promptText }]
        }
      });
      pushEvent(entry, "turn/start", {
        requestId: requestId,
        provider: "claude",
        textLength: promptText.length,
        sessionId: entry.sessionId,
        model: entry.model,
        reasoningEffort: entry.reasoningEffort
      });
      return {
        ok: true,
        status: "submitted",
        handle: handle,
        requestId: requestId,
        cursor: cursor,
        sessionId: entry.sessionId,
        claudeSessionId: entry.sessionId,
        preflight: {
          setupStatus: managedPreflightCurrent ? "current" : "unverified",
          guidanceVersion: mcpProjectGuidanceVersion(),
          skillBundle: entry.managedSkillBundle || null,
          mcpEndpoint: trim(entry.mcpEndpoint)
        },
        timings: { acceptedAt: promptAcceptedAt, submittedAt: now(), totalMs: now() - promptAcceptedAt },
        state: statusOf(entry),
        timestamp: now()
      };
    } catch (e) {
      entry.status = "error";
      entry.phase = "error";
      entry.lastError = String(e);
      pushEvent(entry, "turn/error", { message: String(e), provider: "claude" });
      return { ok: false, status: "error", handle: handle, error: String(e), state: statusOf(entry), timestamp: now() };
    }
  };

  C8O.agentBridge.claudeClose = function (options) {
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
    return { ok: true, status: "closed", handle: handle, state: stateBeforeRemove, timestamp: now() };
  };

  // Stream-json event mapping ------------------------------------------------

  function claudeToolTitle(name) {
    var text = trim(name);
    var mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(text);
    if (mcp !== null) {
      return mcp[1] + "." + mcp[2];
    }
    return text.length ? text : "tool";
  }

  function claudePreview(value) {
    if (value === null || typeof value === "undefined") {
      return "";
    }
    var text = "";
    if (typeof value === "string") {
      text = value;
    } else if (typeof value.length !== "undefined" && typeof value !== "string") {
      var parts = [];
      for (var i = 0; i < value.length; i++) {
        var block = value[i];
        if (block && typeof block === "object" && typeof block.text !== "undefined") {
          parts.push(String(block.text));
        } else if (typeof block === "string") {
          parts.push(block);
        } else {
          try { parts.push(JSON.stringify(block)); } catch (_ignoreBlock) {}
        }
      }
      text = parts.join(" ");
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

  function claudeStreamState(entry) {
    if (!entry.claudeStreamState) {
      entry.claudeStreamState = {};
    }
    return entry.claudeStreamState;
  }

  function claudePushCommentary(entry, text) {
    text = String(text || "");
    if (!trim(text).length) {
      return;
    }
    pushEvent(entry, "answer/chunk", {
      text: text,
      phase: "commentary",
      progressPhase: "commentary",
      source: "stream",
      provider: "claude"
    });
  }

  function claudeFlushBlock(entry, index, force) {
    var state = claudeStreamState(entry);
    var block = state[String(index)];
    if (!block) {
      return;
    }
    if (block.type === "text") {
      // Claude Code gives no commentary/final_answer phase while streaming. Text
      // is buffered per block and only becomes a progress commentary when a tool
      // call follows it; the last text of the turn is the final answer, which the
      // `result` message delivers once. This keeps one Assistant step per
      // narration instead of one step per streamed line.
      if (force !== true) {
        return;
      }
      var completed = String(block.text || block.pending || "");
      block.pending = "";
      block.streamed = true;
      if (trim(completed).length) {
        entry.claudePendingNarration = String(entry.claudePendingNarration || "");
        entry.claudePendingNarration += (entry.claudePendingNarration.length ? "\n" : "") + completed;
      }
      return;
    }
    if (block.type === "thinking" && force === true) {
      var thought = trim(block.text);
      if (thought.length) {
        pushEvent(entry, "reasoning/chunk", { text: thought, provider: "claude" });
      }
      block.text = "";
    }
  }

  function claudeFlushNarration(entry) {
    var narration = String(entry.claudePendingNarration || "");
    entry.claudePendingNarration = "";
    if (trim(narration).length) {
      claudePushCommentary(entry, narration);
    }
  }

  function claudeRegisterToolUse(entry, block) {
    if (!block || !block.id) {
      return;
    }
    if (!entry.claudeToolCalls) {
      entry.claudeToolCalls = {};
    }
    if (entry.claudeToolCalls[block.id]) {
      return;
    }
    claudeFlushNarration(entry);
    var title = claudeToolTitle(block.name);
    entry.claudeToolCalls[block.id] = { name: String(block.name || ""), title: title, startedAt: now() };
    pushEvent(entry, "tool/start", {
      title: title,
      toolName: String(block.name || ""),
      status: "running",
      callId: String(block.id),
      detail: claudePreview(block.input),
      provider: "claude"
    });
  }

  function claudeHandleStreamEvent(entry, event) {
    var type = String(event.type || "");
    var state = claudeStreamState(entry);
    if (type === "message_start") {
      entry.claudeStreamState = {};
      return;
    }
    if (type === "content_block_start") {
      var startBlock = event.content_block || {};
      state[String(event.index)] = { type: String(startBlock.type || ""), pending: "", text: "", streamed: false, id: startBlock.id || "", name: startBlock.name || "" };
      if (startBlock.type === "tool_use") {
        claudeRegisterToolUse(entry, startBlock);
      } else if (startBlock.type === "text" && trim(startBlock.text).length) {
        state[String(event.index)].pending = String(startBlock.text);
        state[String(event.index)].text = String(startBlock.text);
      }
      return;
    }
    if (type === "content_block_delta") {
      var delta = event.delta || {};
      var block = state[String(event.index)];
      if (!block) {
        block = { type: delta.type === "thinking_delta" ? "thinking" : "text", pending: "", text: "", streamed: false };
        state[String(event.index)] = block;
      }
      if (delta.type === "text_delta") {
        block.pending = String(block.pending || "") + String(delta.text || "");
        block.text = String(block.text || "") + String(delta.text || "");
      } else if (delta.type === "thinking_delta") {
        block.text = String(block.text || "") + String(delta.thinking || "");
      }
      return;
    }
    if (type === "content_block_stop") {
      claudeFlushBlock(entry, event.index, true);
      return;
    }
    if (type === "message_delta" || type === "message_stop") {
      return;
    }
    pushEvent(entry, "claude/event", { event: event, provider: "claude" });
  }

  function claudeHandleAssistantMessage(entry, message) {
    var payload = message.message || {};
    var content = payload.content || [];
    var messageId = String(payload.id || "");
    if (!entry.claudeSeenMessages) {
      entry.claudeSeenMessages = {};
    }
    var state = claudeStreamState(entry);
    for (var i = 0; i < content.length; i++) {
      var block = content[i] || {};
      if (block.type === "tool_use") {
        claudeRegisterToolUse(entry, block);
      } else if (block.type === "text") {
        // Text already reached the narration buffer through the stream events
        // (partial messages are always enabled). Without partials, buffer it here.
        var alreadyBuffered = false;
        for (var streamedKey in state) {
          if (Object.prototype.hasOwnProperty.call(state, streamedKey)) {
            var streamedBlock = state[streamedKey];
            if (streamedBlock && streamedBlock.type === "text" && trim(streamedBlock.text) === trim(block.text)) {
              alreadyBuffered = true;
              break;
            }
          }
        }
        if (!alreadyBuffered && !entry.claudeSeenMessages[messageId + ":" + i] && trim(block.text).length) {
          entry.claudePendingNarration = String(entry.claudePendingNarration || "");
          entry.claudePendingNarration += (entry.claudePendingNarration.length ? "\n" : "") + String(block.text);
        }
        entry.claudeSeenMessages[messageId + ":" + i] = true;
      }
    }
  }

  function claudeHandleUserMessage(entry, message) {
    var payload = message.message || {};
    var content = payload.content || [];
    if (typeof content === "string") {
      return;
    }
    for (var i = 0; i < content.length; i++) {
      var block = content[i] || {};
      if (block.type !== "tool_result") {
        continue;
      }
      var callId = String(block.tool_use_id || "");
      var known = entry.claudeToolCalls ? entry.claudeToolCalls[callId] : null;
      var failed = block.is_error === true;
      pushEvent(entry, "tool/update", {
        title: known ? known.title : "tool",
        toolName: known ? known.name : "",
        status: failed ? "failed" : "completed",
        callId: callId,
        detail: claudePreview(block.content),
        provider: "claude"
      });
    }
  }

  function claudeLooksLikeAuthenticationError(text) {
    // A revoked session does not say "oauth token has expired": it says the refresh failed,
    // the token was revoked or the request was unauthorized. Recognising those wordings is
    // what makes the Assistant show the sign-in button instead of a generic turn error.
    var lower = String(text || "").toLowerCase();
    return claudeLooksLikeRevokedSession(lower) ||
      lower.indexOf("please run `claude auth login`") !== -1 ||
      lower.indexOf("claude setup-token") !== -1 ||
      lower.indexOf("oauth authentication") !== -1;
  }

  function claudeHandleResult(entry, message) {
    var subtype = String(message.subtype || "");
    var text = String(message.result || "");
    if (message.session_id && !trim(entry.sessionId).length) {
      entry.sessionId = String(message.session_id);
    }
    if (message.usage) {
      pushEvent(entry, "usage/update", { usage: message.usage, totalCostUsd: message.total_cost_usd || 0, provider: "claude" });
    }
    var isError = message.is_error === true || (subtype.length && subtype !== "success");
    if (isError || claudeLooksLikeAuthenticationError(text)) {
      entry.status = "error";
      entry.phase = "error";
      entry.lastError = text.length ? text : subtype;
      pushEvent(entry, "turn/error", {
        error: { subtype: subtype || "error", message: text },
        message: text.length ? text : ("Claude Code turn failed: " + subtype),
        authentication: claudeLooksLikeAuthenticationError(text),
        provider: "claude"
      });
      return;
    }
    var finalText = trim(text).length ? text : String(entry.claudePendingNarration || "");
    entry.claudePendingNarration = "";
    if (trim(finalText).length) {
      pushEvent(entry, "answer/chunk", { text: finalText, phase: "final_answer", source: "result", provider: "claude" });
    }
    entry.claudeTurnEnded = true;
    entry.status = "completed";
    entry.phase = "completed";
    pushEvent(entry, "turn/end", {
      provider: "claude",
      sessionId: entry.sessionId,
      subtype: subtype,
      durationMs: Number(message.duration_ms || 0),
      numTurns: Number(message.num_turns || 0)
    });
  }

  function claudeHandleControlRequest(entry, message) {
    var request = message.request || {};
    var subtype = String(request.subtype || "");
    var requestId = message.request_id || request.request_id || "";
    pushEvent(entry, "claude/control_request", { requestId: requestId, subtype: subtype, provider: "claude" });
    if (subtype === "can_use_tool") {
      pushEvent(entry, "permission/selected", { optionId: "allow", toolCall: { name: request.tool_name || "", input: request.input || {} }, provider: "claude" });
      writeJson(entry, {
        type: "control_response",
        response: {
          subtype: "success",
          request_id: requestId,
          response: { behavior: "allow", updatedInput: request.input || {} }
        }
      });
      return;
    }
    writeJson(entry, {
      type: "control_response",
      response: {
        subtype: "error",
        request_id: requestId,
        error: "Unsupported control request: " + subtype
      }
    });
  }

  function handleClaudeStreamLine(entry, line, streamName) {
    var text = trim(line);
    if (!text.length) {
      return;
    }
    if (streamName !== "stdout") {
      if (streamName === "stderr") {
        entry.lastError = text;
      }
      pushEvent(entry, streamName, { line: text, provider: "claude" });
      return;
    }
    var message;
    try {
      message = JSON.parse(text);
    } catch (_ignoreClaudeJson) {
      pushEvent(entry, "diagnostic", { line: text, provider: "claude" });
      return;
    }
    var type = String(message.type || "");
    if (message.session_id && !trim(entry.sessionId).length) {
      entry.sessionId = String(message.session_id);
      pushEvent(entry, "session/update", { sessionId: entry.sessionId, provider: "claude" });
    }
    if (type === "system") {
      var subtype = String(message.subtype || "");
      if (subtype === "init") {
        var servers = message.mcp_servers || [];
        var failedServers = [];
        for (var i = 0; i < servers.length; i++) {
          if (String(servers[i] && servers[i].status || "") !== "connected") {
            failedServers.push(String(servers[i] && servers[i].name || "") + ":" + String(servers[i] && servers[i].status || ""));
          }
        }
        pushEvent(entry, "claude/init", {
          sessionId: String(message.session_id || ""),
          model: String(message.model || ""),
          mcpServers: servers,
          toolCount: (message.tools || []).length,
          provider: "claude"
        });
        if (failedServers.length) {
          // The Convertigo MCP server is the only authoring surface. Without it the
          // agent must stop instead of improvising on the workspace filesystem.
          var mcpFailure = "The Convertigo MCP server is not available to Claude Code (" + failedServers.join(", ") + "). The turn was stopped; restart the agent session from Studio so the Agent Bridge renews the MCP configuration and token.";
          entry.status = "error";
          entry.phase = "error";
          entry.lastError = mcpFailure;
          pushEvent(entry, "turn/error", {
            error: { subtype: "mcp_unavailable", message: mcpFailure, servers: failedServers },
            message: mcpFailure,
            provider: "claude"
          });
          try {
            stopEntry(entry, false);
          } catch (_ignoreStopAfterMcpFailure) {}
        }
        return;
      }
      pushEvent(entry, "claude/event", { method: "system/" + subtype, params: message, provider: "claude" });
      return;
    }
    if (type === "stream_event") {
      claudeHandleStreamEvent(entry, message.event || {});
      return;
    }
    if (type === "assistant") {
      claudeHandleAssistantMessage(entry, message);
      return;
    }
    if (type === "user") {
      claudeHandleUserMessage(entry, message);
      return;
    }
    if (type === "result") {
      claudeHandleResult(entry, message);
      return;
    }
    if (type === "control_request") {
      claudeHandleControlRequest(entry, message);
      return;
    }
    pushEvent(entry, "claude/event", { method: type, params: message, provider: "claude" });
  }
