// Vibe ACP provider implementation.
// Loaded by vibe_agent_bridge.js after agent_bridge_common.js.
  C8O.agentBridge.vibeSetup = function (options) {
    options = optionsWithRequestFallbacks(options || {});
    if (boolValue(options.loginStatus || options.vibeLoginStatus, false)) {
      return C8O.agentBridge.vibeLoginStatus(options);
    }
    if (boolValue(options.login || options.vibeLogin, false)) {
      return C8O.agentBridge.vibeLoginStart(options);
    }
    if (trim(options.gatewayApiKey).length) {
      var stored = C8O.agentBridge.vibeGatewayKeyStore(options);
      if (stored.ok !== true) {
        return stored;
      }
      options.gatewayApiKey = "";
    }
    var profile = resolveVibeProfile(options);
    var install = boolValue(options.install, false);
    var forceVibeInstall = boolValue(options.forceVibeInstall || options.forceInstall || options.force, false);
    var configure = boolValue(options.configure, false);
    var startupPresenceOnly = boolValue(options.startupPresenceOnly, false) && !install;
    var detectSetup = function () {
      return startupPresenceOnly ? detectRuntimePresence(options) : detectRuntime(options);
    };
    var setup = detectSetup();
    var workspaceFirstOption = typeof options.workspaceInstallFirst !== "undefined" ? options.workspaceInstallFirst : options.preferWorkspaceInstall;
    var workspaceFirst = boolValue(typeof workspaceFirstOption === "undefined" ? true : workspaceFirstOption, true);
    var installation = {
      attempted: false,
      installed: false,
      python: null,
      steps: []
    };
    var messages = [];
    var bootstrap = {
      attempted: false,
      ok: true,
      home: setup.vibeHome,
      copied: [],
      reused: [],
      refreshed: [],
      message: "",
      error: ""
    };

    var runInstallStep = function (args, timeoutMs, label, proxyTargetUrl) {
      var result = runCommandCaptured(args, { timeoutMs: timeoutMs, proxyTargetUrl: proxyTargetUrl || "" });
      installation.steps.push(compactCommandResult(result, 4000));
      requireSuccessfulCommand(result, label);
    };

    try {
      if (setup.home.error) {
        throw new Error(setup.home.error);
      }
      if (configure) {
        var expectedBearerEnv = usesProtectedConvertigoMcp(setup.mcpEndpoint, options) ? mcpBearerTokenEnv(options) : "";
        var expectedViewerDebugPort = intValue(options.viewerDebugPort, 0, 0, 65535);
        if (vibePlaywrightEnabled(options) && !new File(childPath(childPath(codexNodeModulesPath(setup.installDir), "@playwright/mcp"), "package.json")).isFile()) {
          var vibePlaywright = ensureVibePlaywrightRuntime(options, setup.installDir);
          if (vibePlaywright.error) {
            messages.push("Playwright MCP is not available in the managed Vibe runtime: " + vibePlaywright.error);
          } else if (vibePlaywright.installed === true) {
            messages.push("Playwright MCP installed in the managed Vibe runtime.");
          }
        }
        var expectedGatewayUrl = profile === "convertigo" ? convertigoGatewayUrl(options) : "";
        // Rewrite the config, hence restart Vibe on it, when the gateway offer changed since
        // this home was written. It also covers a resumed conversation.
        var expectedGatewayModels = profile === "convertigo" ? vibeGatewayModelsFingerprint(vibeGatewayModelSpecs(options, setup.vibeHome)) : "";
        var expectedRevealMode = expectedBearerEnv.length && revealModeEnabled(options, null);
        var expectedNoLog = expectedBearerEnv.length && mcpNoLogEnabled(options);
        var expectedPlaywright = vibePlaywrightServer(options);
        var expectedPlaywrightEndpoint = expectedPlaywright === null ? "" : resolvePlaywrightMcpCdpEndpoint(options);
        var expectedPlaywrightCommand = expectedPlaywright === null ? "" : trim(expectedPlaywright.command);
        if (setup.config.selected.valid
            && trim(setup.config.selected.endpoint) === vibeMcpTransportEndpoint(setup.mcpEndpoint, options)
            && trim(setup.config.selected.bearerTokenEnv) === expectedBearerEnv
            && Number(setup.config.selected.viewerDebugPort || 0) === (expectedBearerEnv.length ? expectedViewerDebugPort : 0)
            && trim(setup.config.selected.playwrightEndpoint) === expectedPlaywrightEndpoint
            && trim(setup.config.selected.playwrightCommand) === expectedPlaywrightCommand
            && trim(setup.config.selected.gatewayUrl) === expectedGatewayUrl
            && trim(setup.config.selected.gatewayModels) === expectedGatewayModels
            && (setup.config.selected.revealMode === true) === expectedRevealMode
            && (setup.config.selected.noLog === true) === expectedNoLog) {
          messages.push("Local VIBE_HOME config reused: " + setup.config.selected.path);
        } else {
          var written = writeLocalVibeConfig(setup.vibeHome, setup.mcpEndpoint, options.model || options.agentModel, options);
          messages.push("Local VIBE_HOME config written: " + written.path + " (" + written.model + ")");
          // The MCP server entry just changed, so the tool catalog Vibe cached
          // under the previous one is unreachable and stale.
          var prunedDescriptors = pruneVibeDescriptorCache(setup.vibeHome);
          if (prunedDescriptors.removed.length) {
            messages.push("Stale Vibe MCP descriptor cache removed: " + prunedDescriptors.removed.join(", "));
          }
        }
        var presetMigration = migrateManagedVibeConfig(setup.vibeHome);
        if (presetMigration.removed.length) {
          messages.push("Legacy managed Vibe model preset migrated: " + presetMigration.removed.join(", "));
        }
      }
      bootstrap = bootstrapVibeHome(setup.vibeHome, options);
      if (bootstrap.message) {
        messages.push(bootstrap.message);
      }
      if (!bootstrap.ok) {
        throw new Error(bootstrap.error || bootstrap.message);
      }

      var workspaceVibeReady = commandPathStartsWith(setup.vibe, setup.installDir) && commandPathStartsWith(setup.vibeAcp, setup.installDir);
      if (install && (forceVibeInstall || !setup.vibe.found || !setup.vibeAcp.found || (workspaceFirst && !workspaceVibeReady))) {
        installation.attempted = true;
        ensureDirectory(new File(setup.installDir));
        installation.python = ensurePythonRuntime({
          workspaceRoot: options.workspaceRoot,
          pythonPath: options.pythonPath,
          pythonInstallDir: options.pythonInstallDir,
          pythonArchiveUrl: options.pythonArchiveUrl,
          pythonArchiveSha256: options.pythonArchiveSha256,
          pythonAssetUrlPrefix: options.pythonAssetUrlPrefix,
          pythonMirrorBaseUrl: options.pythonMirrorBaseUrl,
          pythonVersion: options.pythonVersion,
          pythonBuildTag: options.pythonBuildTag,
          pythonPlatform: options.pythonPlatform,
          pythonArchiveFlavor: options.pythonArchiveFlavor,
          allowPythonDownload: typeof options.allowPythonDownload === "undefined" ? true : options.allowPythonDownload,
          forcePythonInstall: options.forcePythonInstall,
          workspaceInstallFirst: workspaceFirst
        });
        var basePython = installation.python && installation.python.python ? installation.python.python : null;
        if (!basePython || !basePython.found) {
          throw new Error("Managed Python is required to install mistral-vibe");
        }
        if (workspaceFirst && !commandPathStartsWith(basePython, installation.python.runtime.installDir)) {
          throw new Error("Python setup did not select the managed workspace runtime");
        }
        var venvExists = new File(setup.venvDir).exists();
        var venvManaged = !venvExists || !workspaceFirst || commandPathStartsWith({
          path: parseTomlValue(readTextFile(new File(setup.venvDir, "pyvenv.cfg")), "home")
        }, installation.python.runtime.installDir);
        if (!venvExists || !venvManaged) {
          var venvArgs = [basePython.path, "-m", "venv"];
          if (venvExists) {
            venvArgs.push("--clear");
          }
          venvArgs.push(setup.venvDir);
          runInstallStep(venvArgs, 120000, "Vibe virtual environment creation");
        }
        var venvPython = venvBinPath(setup.venvDir, "python");
        runInstallStep([venvPython, "-m", "pip", "install", "--upgrade", "pip"], 180000, "Vibe pip bootstrap", "https://pypi.org");
        runInstallStep([venvPython, "-m", "pip", "install", "--upgrade", "mistral-vibe"], 600000, "Vibe runtime installation", "https://pypi.org");

        setup = detectRuntime(options);
        var managedVibeReady = commandPathStartsWith(setup.vibe, setup.venvDir) && commandPathStartsWith(setup.vibeAcp, setup.venvDir);
        if (!managedVibeReady) {
          throw new Error("Vibe installation completed without runnable managed vibe and vibe-acp commands in " + setup.venvDir);
        }
        installation.installed = true;
      }
    } catch (e) {
      messages.push(String(e));
      setup = detectSetup();
      if (!workspaceFirst && setup.vibe.found && setup.vibeAcp.found && !forceVibeInstall) {
        messages.push("Workspace Vibe install failed; using user PATH fallback.");
        installation.error = String(e);
        var fallbackSkills = installAgentSkills(options, "vibe", setup.vibeHome);
        if (fallbackSkills.message) {
          messages.push(fallbackSkills.message);
        }
        if (fallbackSkills.error) {
          messages.push(fallbackSkills.error);
        }
        var fallbackAuthentication = inspectVibeAuthentication(setup.vibeHome, profile);
        var fallbackReady = fallbackAuthentication.configured === true && fallbackSkills.ok !== false;
        if (!fallbackReady) {
          messages.push(fallbackAuthentication.configured === true
            ? "Vibe skill configuration is required before start."
            : vibeAuthenticationRequiredMessage(profile));
        }
        return {
          ok: fallbackReady,
          status: fallbackReady ? "ready" : (fallbackSkills.ok === false ? "configuration_error" : "authentication_required"),
          phase: "fallback",
          setup: setup,
          authentication: fallbackAuthentication,
          installation: installation,
          bootstrap: bootstrap,
          skills: fallbackSkills,
          messages: messages,
          timestamp: now()
        };
      }
      return {
        ok: false,
        status: "error",
        phase: "setup",
        error: String(e),
        setup: setup,
        installation: installation,
        bootstrap: bootstrap,
        messages: messages,
        timestamp: now()
      };
    }

    if (installation.installed !== true) {
      setup = detectSetup();
    }
    var runtimeReady = setup.vibe.found && setup.vibeAcp.found && (!workspaceFirst || (
      commandPathStartsWith(setup.vibe, setup.venvDir) && commandPathStartsWith(setup.vibeAcp, setup.venvDir)
    ));
    var authentication = inspectVibeAuthentication(setup.vibeHome, profile);
    var skills = installAgentSkills(options, "vibe", setup.vibeHome);
    var skillsReady = skills.ok !== false;
    var ready = runtimeReady && authentication.configured === true && skillsReady;
    if (runtimeReady && authentication.configured !== true) {
      messages.push(vibeAuthenticationRequiredMessage(profile));
    }
    if (!skillsReady) {
      messages.push(skills.error || "Vibe skill configuration is required before start.");
    }
    if (!setup.config.selected.valid) {
      messages.push("Selected VIBE_HOME has no valid Convertigo MCP HTTP server config yet");
    }
    if (skills.message) {
      messages.push(skills.message);
    }
    if (skills.error) {
      messages.push(skills.error);
    }
    return {
      ok: ready,
      status: ready ? "ready" : (!skillsReady ? "configuration_error" : (runtimeReady ? "authentication_required" : "missing")),
      setup: setup,
      authentication: authentication,
      installation: installation,
      bootstrap: bootstrap,
      skills: skills,
      messages: messages,
      timestamp: now()
    };
  };

  C8O.agentBridge.pythonSetup = function (options) {
    options = options || {};
    var installOption = typeof options.install !== "undefined" ? options.install : options.installPython;
    var install = boolValue(installOption, false);
    var messages = [];
    try {
      var before = detectPythonRuntime(options, "");
      var installation = {
        attempted: false,
        installed: false,
        reused: false,
        steps: []
      };
      if (install) {
        installation = ensurePythonRuntime(options);
      }
      var after = detectPythonRuntime(options, "");
      var ready = after.command.found;
      if (!ready && !install) {
        messages.push("Python is missing. Call with install=true to install a workspace-local runtime.");
      }
      return {
        ok: ready,
        status: ready ? "ready" : "missing",
        workspaceRoot: after.workspaceRoot,
        python: after.command,
        pythonRuntime: after.runtime,
        before: before.command,
        installation: installation,
        messages: messages,
        timestamp: now()
      };
    } catch (e) {
      return {
        ok: false,
        status: "error",
        phase: "python_setup",
        error: String(e),
        setup: detectPythonRuntime(options, ""),
        messages: messages,
        timestamp: now()
      };
    }
  };

  C8O.agentBridge.vibeStart = function (options) {
    options = optionsWithRequestFallbacks(options || {});
    var requestedModel = trim(options.model || options.agentModel);
    var handle = trim(options.handle) || makeHandle("vibe");
    try {
      ensureManagedViewerDebugPort(options);
    } catch (viewerDebugPortError) {
      return { ok: false, status: "error", phase: "viewer_debug_port", error: String(viewerDebugPortError), timestamp: now() };
    }
    if (intValue(options.viewerDebugPort, 0, 0, 65535) >= 1024 && !trim(options.vibeHome).length) {
      options.vibeHomeScope = "conversation";
      options.homeScope = "conversation";
    }
    var registry = getRegistry();
    var existing = registry.get(handle);
    var timeoutMs = intValue(options.requestTimeoutMs, 60000, 1000, 600000);
    if (existing !== null && typeof existing !== "undefined" && processAlive(existing.process)) {
      var requestedMcpTokenFingerprint = mcpBearerTokenFingerprint(options);
      var requestedPlaywrightCdpEndpoint = resolvePlaywrightMcpCdpEndpoint(options);
      var activePlaywrightCdpEndpoint = trim(existing.playwrightCdpEndpoint || existing.viewerCdpEndpoint);
      var viewerChanged = requestedPlaywrightCdpEndpoint.length && activePlaywrightCdpEndpoint !== requestedPlaywrightCdpEndpoint;
      var revealChanged = (existing.convertigoRevealMode === true) !== revealModeEnabled(options, null);
      if (requestedMcpTokenFingerprint.length
          && trim(existing.mcpBearerTokenFingerprint) !== requestedMcpTokenFingerprint) {
        pushEvent(existing, "warning", {
          phase: "mcp/auth",
          message: "Vibe must restart to renew its managed Convertigo MCP authorization."
        });
        stopEntry(existing, true);
        existing = null;
      } else if (viewerChanged) {
        pushEvent(existing, "warning", {
          phase: "viewer",
          reason: "playwright_endpoint_changed",
          message: "Vibe must restart to refresh the managed Playwright MCP viewer endpoint.",
          previousEndpoint: activePlaywrightCdpEndpoint,
          requestedEndpoint: requestedPlaywrightCdpEndpoint
        });
        stopEntry(existing, true);
        existing = null;
      } else if (revealChanged) {
        // The reveal request travels as an MCP header in config.toml: restart to apply it.
        pushEvent(existing, "warning", {
          phase: "reveal",
          reason: "reveal_mode_changed",
          message: "Vibe must restart to update Convertigo reveal mode."
        });
        stopEntry(existing, true);
        existing = null;
      }
    }
    if (existing !== null && typeof existing !== "undefined" && processAlive(existing.process)) {
      try {
        configureVibeSession(existing, options, timeoutMs);
      } catch (configureExistingError) {
        pushEvent(existing, "warning", {
          phase: "session/config",
          message: String(configureExistingError)
        });
      }
      rememberSessionHandle(handle);
      return {
        ok: true,
        status: "already_running",
        handle: handle,
        providerSettings: existing.providerSettings || null,
        state: statusOf(existing),
        timestamp: now()
      };
    }
    var autoConfigure = boolValue(options.autoConfigure, !trim(options.vibeHome).length);
    var setup = C8O.agentBridge.vibeSetup({
      vibeProfile: resolveVibeProfile(options),
      llmGatewayUrl: options.llmGatewayUrl,
      llmGatewayModel: options.llmGatewayModel,
      llmGatewayThinking: options.llmGatewayThinking,
      workspaceRoot: options.workspaceRoot,
      installDir: options.installDir,
      vibeHome: options.vibeHome,
      vibeHomeScope: options.vibeHomeScope || options.homeScope || options.scope,
      userId: options.userId,
      conversationId: options.conversationId,
      projectId: options.projectId,
      mcpEndpoint: options.mcpEndpoint,
      model: "",
      install: boolValue(options.install, false),
      pythonPath: options.pythonPath,
      pythonInstallDir: options.pythonInstallDir,
      pythonArchiveUrl: options.pythonArchiveUrl,
      pythonArchiveSha256: options.pythonArchiveSha256,
      pythonAssetUrlPrefix: options.pythonAssetUrlPrefix,
      pythonMirrorBaseUrl: options.pythonMirrorBaseUrl,
      pythonVersion: options.pythonVersion,
      pythonBuildTag: options.pythonBuildTag,
      pythonPlatform: options.pythonPlatform,
      pythonArchiveFlavor: options.pythonArchiveFlavor,
      allowPythonDownload: options.allowPythonDownload,
      forcePythonInstall: options.forcePythonInstall,
      mcpBearerToken: options.mcpBearerToken,
      mcpBearerTokenHandle: options.mcpBearerTokenHandle,
      nocodeMcpToken: options.nocodeMcpToken || options.noCodeMcpToken,
      nocodeMcpTokenHandle: options.nocodeMcpTokenHandle || options.noCodeMcpTokenHandle,
      agentProfile: options.agentProfile,
      skillProfile: options.skillProfile,
      assistantContext: options.assistantContext,
      viewerDebugPort: options.viewerDebugPort,
      browserDebugUrl: options.browserDebugUrl,
      browserDevToolsJsonUrl: options.browserDevToolsJsonUrl,
      browserDevToolsWebSocketUrl: options.browserDevToolsWebSocketUrl,
      playwrightCdpEndpoint: options.playwrightCdpEndpoint || options.viewerCdpEndpoint,
      playwrightMcpEndpoint: options.playwrightMcpEndpoint,
      skipPlaywrightInstall: options.skipPlaywrightInstall || options.skipVibePlaywrightInstall,
      configure: autoConfigure,
      startupPresenceOnly: true
    });
    if (!setup.ok) {
      var authenticationRequired = setup.status === "authentication_required";
      return {
        ok: false,
        status: authenticationRequired ? "authentication_required" : "error",
        phase: "setup",
        error: authenticationRequired ? "Vibe authentication is required before start" : (setup.error || (setup.skills && setup.skills.error) || "Vibe local setup is required before start"),
        setup: setup,
        timestamp: now()
      };
    }

    var env = parseObject(options.env, {});
    var vibeHome = setup.setup.vibeHome;
    if (!trim(options.credentialsPolicy || options.envPolicy).length) {
      options.credentialsPolicy = "vibe-home";
    }
    var credentials = applyCredentialsPolicy(env, options, vibeHome);
    if (vibeHome.length) {
      env.VIBE_HOME = vibeHome;
    }
    var vibeNodePath = nodeRuntimeSearchPath(options);
    if (vibeNodePath.length && !trim(env.PATH).length) {
      env.PATH = vibeNodePath + String(File.pathSeparator) + String(System.getenv("PATH") || "");
    }
    applyManagedMcpEnvironment(env, options);
    var cwd = normalizeDirectory(options.cwd, setup.setup.workspaceRoot, setup.setup.workspaceRoot);
    var mcpEndpoint = trim(options.mcpEndpoint) || setup.setup.mcpEndpoint || resolveMcpEndpoint(options);
    var command = parseCommand(options.command, [setup.setup.vibeAcp.path || "vibe-acp"]);
    var ttlMillis = intValue(options.ttlSeconds, DEFAULT_TTL_SECONDS, 30, 86400) * 1000;
    var entry = createEntry(handle, "vibe", "acp", command, cwd, env, ttlMillis, setup.setup.home, credentials, requestedModel || setup.setup.model);
    entry.vibeProfile = resolveVibeProfile(options);
    entry.mcpBearerTokenFingerprint = mcpBearerTokenFingerprint(options);
    entry.workspaceRoot = setup.setup.workspaceRoot;
    entry.convertigoRevealMode = revealModeEnabled(options, null);
    entry.viewerDebugPort = intValue(options.viewerDebugPort, 0, 0, 65535);
    entry.browserDebugUrl = trim(options.browserDebugUrl);
    entry.playwrightCdpEndpoint = resolvePlaywrightMcpCdpEndpoint(options);
    entry.viewerCdpEndpoint = trim(options.viewerCdpEndpoint || entry.playwrightCdpEndpoint);
    entry.playwrightMcpEnabled = trim(setup.setup.config && setup.setup.config.selected && setup.setup.config.selected.playwrightEndpoint).length > 0;
    registry.put(handle, entry);

    try {
      startProcess(entry, env);
      pushEvent(entry, "system/start", {
        handle: handle,
        command: command,
        cwd: cwd,
        envKeys: envKeys(env),
        vibeHome: vibeHome,
        model: setup.setup.model,
        home: publicHomeInfo(setup.setup.home),
        credentials: {
          policy: credentials.policy,
          injectedKeys: credentials.injectedKeys,
          sources: credentials.sources
        },
        mcpEndpoint: mcpEndpoint,
        viewerDebugPort: entry.viewerDebugPort,
        playwrightCdpEndpoint: entry.playwrightCdpEndpoint,
        playwrightMcpEnabled: entry.playwrightMcpEnabled === true
      });

      entry.phase = "initialize";
      entry.init = acpRequest(entry, "initialize", {
        protocolVersion: 1,
        clientInfo: {
          name: "lib_ConvertigoAgentBridge",
          version: "0.1.0"
        },
        clientCapabilities: {
          fs: {
            readTextFile: false,
            writeTextFile: false
          },
          terminal: false,
          auth: {
            terminal: false
          },
          session: {
            configOptions: {}
          }
        }
      }, timeoutMs);

      entry.phase = "session/new";
      entry.session = acpRequest(entry, "session/new", {
        cwd: cwd,
        mcpServers: buildMcpServers(mcpEndpoint, options)
      }, timeoutMs);
      entry.sessionId = String(entry.session.sessionId || entry.session.session_id || "");
      var sessionProvider = vibeSettings({
        vibeProfile: resolveVibeProfile(options),
        workspaceRoot: setup.setup.workspaceRoot,
        vibeHome: setup.setup.vibeHome,
        vibeHomeScope: "explicit",
        mcpEndpoint: mcpEndpoint,
        runtimePresenceOnly: true
      });
      updateVibeProviderSettings(entry, entry.session.configOptions || entry.session.config_options || [], sessionProvider);
      configureVibeSession(entry, options, timeoutMs);
      entry.phase = "ready";
      entry.status = "running";
      pushEvent(entry, "acp/session", {
        sessionId: entry.sessionId,
        result: entry.session
      });
      rememberSessionHandle(handle);

      return {
        ok: true,
        status: "started",
        handle: handle,
        sessionId: entry.sessionId,
        cursor: entry.nextIndex,
        providerSettings: entry.providerSettings || null,
        state: statusOf(entry),
        timestamp: now()
      };
    } catch (e) {
      entry.status = "error";
      entry.lastError = String(e);
      entry.closedAt = now();
      pushEvent(entry, "error", {
        message: String(e),
        phase: entry.phase,
        acpError: e.acpError || null
      });
      stopEntry(entry, false);
      return {
        ok: false,
        status: "error",
        phase: entry.phase,
        error: String(e),
        acpError: e.acpError || null,
        handle: handle,
        state: statusOf(entry),
        timestamp: now()
      };
    }
  };

  C8O.agentBridge.discoverVibeSettings = function (options, provider) {
    options = options || {};
    provider = provider || {};
    var setup = provider.setup || {};
    var handle = makeHandle("vibe-settings");
    var started = null;
    try {
      var discoveryProfile = trim(provider.profile) || (typeof resolveVibeProfile === "function" ? resolveVibeProfile(options) : "mistral");
      started = C8O.agentBridge.vibeStart({
        handle: handle,
        vibeProfile: discoveryProfile,
        llmGatewayUrl: options.llmGatewayUrl || (provider.gateway && provider.gateway.url),
        // Only an explicit model pins the offer; the default one must not hide the others.
        llmGatewayModel: options.llmGatewayModel,
        llmGatewayThinking: options.llmGatewayThinking,
        workspaceRoot: trim(options.workspaceRoot || setup.workspaceRoot),
        vibeHome: trim(options.vibeHome || setup.vibeHome),
        vibeHomeScope: trim(options.vibeHome || setup.vibeHome).length ? "explicit" : (options.vibeHomeScope || options.homeScope),
        userId: options.userId,
        conversationId: options.conversationId,
        projectId: options.projectId,
        mcpEndpoint: options.mcpEndpoint,
        model: "",
        reasoningEffort: "",
        mcpBearerToken: options.mcpBearerToken,
        mcpBearerTokenHandle: options.mcpBearerTokenHandle,
        nocodeMcpToken: options.nocodeMcpToken || options.noCodeMcpToken,
        nocodeMcpTokenHandle: options.nocodeMcpTokenHandle || options.noCodeMcpTokenHandle,
        install: false,
        autoConfigure: true,
        disableViewerDebugPortReservation: true,
        disablePlaywrightMcp: true,
        requestTimeoutMs: options.settingsTimeoutMs || options.requestTimeoutMs || 60000
      });
      if (started && started.ok !== false && started.providerSettings) {
        var discovered = started.providerSettings;
        // The ACP catalog only knows models: keep the logical identity and diagnostics.
        ["id", "label", "harness", "profile", "gateway", "identity", "authentication", "runtime", "setup", "skills", "agentProfile", "profileSupported"].forEach(function (key) {
          if (typeof provider[key] !== "undefined" && provider[key] !== null && (key === "id" || key === "label" || key === "harness" || key === "profile" || key === "gateway" || key === "identity" || typeof discovered[key] === "undefined")) {
            discovered[key] = provider[key];
          }
        });
        return applyGatewayOfferToProvider(discovered);
      }
      provider.source = provider.source || {};
      provider.source.discoveryError = started && started.error ? String(started.error) : "Vibe model discovery returned no catalog";
      provider.source.settingsCachedAt = 0;
      return provider;
    } catch (e) {
      provider.source = provider.source || {};
      provider.source.discoveryError = String(e);
      return provider;
    } finally {
      try {
        C8O.agentBridge.vibeClose({ handle: handle });
      } catch (_ignoreVibeSettingsProbeClose) {}
    }
  };

  C8O.agentBridge.vibePrompt = function (options) {
    options = options || {};
    var handle = resolveHandle(options.handle);
    if (!handle.length) {
      return { ok: false, status: "error", error: "handle is required", timestamp: now() };
    }
    var entry = getRegistry().get(handle);
    if (entry === null || typeof entry === "undefined") {
      return { ok: false, status: "not_found", handle: handle, error: "Unknown handle", timestamp: now() };
    }
    if (!processAlive(entry.process) || entry.status !== "running") {
      return { ok: false, status: "not_running", handle: handle, state: statusOf(entry), timestamp: now() };
    }

    entry.convertigoRevealMode = revealModeEnabled(options, entry);
    var promptText = String(options.prompt || "");
    if (!trim(promptText).length) {
      return { ok: false, status: "error", handle: handle, error: "prompt is required", timestamp: now() };
    }
    promptText = withRevealModePrompt(promptText, entry.convertigoRevealMode === true);
    var messageId = trim(options.messageId);
    var promptBlocks = [{
      type: "text",
      text: promptText
    }];
    var images = vibeImageBlocks(firstDefinedOption(options, ["images", "imagePaths", "attachments"]) || optionOrRequest(options, "images"), entry.model);
    for (var imageIndex = 0; imageIndex < images.blocks.length; imageIndex++) {
      promptBlocks.push(images.blocks[imageIndex]);
    }
    if (images.skipped.length) {
      pushEvent(entry, "warning", {
        phase: "prompt/images",
        message: "Some attached images were not sent to Vibe: " + JSON.stringify(images.skipped),
        skipped: images.skipped,
        provider: "vibe"
      });
      var noVision = images.skipped.filter(function (item) { return item.reason === "model_without_vision"; });
      if (noVision.length) {
        promptBlocks[0].text += "\n\nNote from the Agent Bridge: " + noVision.length + " attached image(s) could not be sent to the active model `"
          + trim(noVision[0].model) + "` because it has no image input on this account. Tell the user that this model cannot see images and that Mistral Medium, Codex, or Claude can, then continue with the text of the request.";
      }
    }
    var params = {
      sessionId: entry.sessionId,
      prompt: promptBlocks
    };
    if (messageId.length) {
      params.messageId = messageId;
    }

    try {
      var pending = sendAcpRequest(entry, "session/prompt", params);
      pushEvent(entry, "turn/start", {
        requestId: pending.id,
        messageId: messageId,
        textLength: promptText.length,
        imageCount: images.blocks.length
      });
      var wait = boolValue(options.waitForCompletion, false);
      if (wait) {
        var timeoutMs = intValue(options.requestTimeoutMs, 600000, 1000, 3600000);
        var response = waitForPending(entry, pending, timeoutMs, true);
        return {
          ok: true,
          status: "completed",
          handle: handle,
          requestId: pending.id,
          response: response,
          cursor: entry.nextIndex,
          state: statusOf(entry),
          timestamp: now()
        };
      }
      return {
        ok: true,
        status: "submitted",
        handle: handle,
        requestId: pending.id,
        cursor: entry.nextIndex,
        state: statusOf(entry),
        timestamp: now()
      };
    } catch (e) {
      entry.lastError = String(e);
      pushEvent(entry, "turn/error", {
        message: String(e),
        acpError: e.acpError || null
      });
      return {
        ok: false,
        status: "error",
        handle: handle,
        error: String(e),
        acpError: e.acpError || null,
        state: statusOf(entry),
        timestamp: now()
      };
    }
  };

  C8O.agentBridge.vibeClose = function (options) {
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
    try {
      if (processAlive(entry.process) && entry.sessionId) {
        acpRequest(entry, "session/close", { sessionId: entry.sessionId }, 3000);
      }
    } catch (e) {
      pushEvent(entry, "warning", { message: String(e), phase: "session/close" });
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

  // Browser login (Mistral AI Studio sign-in) ------------------------------
  //
  // Vibe only exposes its browser sign-in through the interactive onboarding TUI
  // (`vibe --setup`) or through ACP `authenticate`. The bridge drives the same
  // Python service headlessly with the managed venv interpreter: the helper prints
  // the sign-in URL, waits for the browser confirmation, then stores the API key in
  // the user scoped VIBE_HOME `.env` (never in the bridge output).

  var VIBE_LOGIN_SCRIPT_NAME = "c8o_vibe_browser_login.py";
  var VIBE_LOGIN_SCRIPT_VERSION = "3";

  function vibeLoginScriptSource() {
    return [
      "# Generated by lib_ConvertigoAgentBridge (v" + VIBE_LOGIN_SCRIPT_VERSION + "). Do not edit.",
      "# Headless Mistral AI Studio browser sign-in for a managed VIBE_HOME.",
      "import asyncio",
      "import os",
      "import pathlib",
      "import sys",
      "",
      "",
      "def emit(tag, value=''):",
      "    sys.stdout.write(tag + (' ' + str(value) if value != '' else '') + '\\n')",
      "    sys.stdout.flush()",
      "",
      "",
      "def write_env(path, key, value):",
      "    path.parent.mkdir(parents=True, exist_ok=True)",
      "    lines = path.read_text(encoding='utf-8').splitlines() if path.exists() else []",
      "    out = []",
      "    replaced = False",
      "    for line in lines:",
      "        body = line.strip()",
      "        if body.startswith('export '):",
      "            body = body[7:].strip()",
      "        if body.startswith(key + '='):",
      "            if not replaced:",
      "                out.append(key + '=' + value)",
      "                replaced = True",
      "            continue",
      "        out.append(line)",
      "    if not replaced:",
      "        out.append(key + '=' + value)",
      "    tmp = path.with_name(path.name + '.tmp')",
      "    tmp.write_text('\\n'.join(out) + '\\n', encoding='utf-8')",
      "    try:",
      "        os.chmod(tmp, 0o600)",
      "    except OSError:",
      "        pass",
      "    os.replace(tmp, path)",
      "",
      "",
      "def main():",
      "    home = os.environ.get('VIBE_HOME', '').strip()",
      "    if not home:",
      "        emit('C8O_LOGIN_ERROR', 'VIBE_HOME is not set')",
      "        return 2",
      "    try:",
      "        from vibe.core.config import DEFAULT_PROVIDERS",
      "        from vibe.setup.auth import BrowserSignInError, BrowserSignInErrorCode, BrowserSignInService, HttpBrowserSignInGateway",
      "    except Exception as exc:",
      "        emit('C8O_LOGIN_ERROR', 'Vibe browser sign-in is not available in this runtime: ' + str(exc))",
      "        return 3",
      "    provider = next((item for item in DEFAULT_PROVIDERS if item.name == 'mistral'), None)",
      "    if provider is None or not provider.supports_browser_sign_in:",
      "        emit('C8O_LOGIN_ERROR', 'The Mistral provider does not support browser sign-in')",
      "        return 3",
      "    env_key = provider.api_key_env_var or 'MISTRAL_API_KEY'",
      "",
      "    async def wait_for_completion(gateway, attempt):",
      "        # Mistral rate-limits the poll endpoint (HTTP 429 after ~1 minute at 3 s);",
      "        # Vibe's own service gives up after 3 consecutive failures, so poll more",
      "        # slowly and back off on failures until the attempt expires.",
      "        from datetime import UTC, datetime",
      "        delay = 5.0",
      "        while datetime.now(UTC) < attempt.expires_at:",
      "            try:",
      "                result = await gateway.poll(attempt.poll_url)",
      "            except BrowserSignInError as exc:",
      "                if exc.code is not BrowserSignInErrorCode.POLL_FAILED:",
      "                    raise",
      "                delay = min(delay * 2, 30.0)",
      "                await asyncio.sleep(delay)",
      "                continue",
      "            delay = 5.0",
      "            if result.status == 'pending':",
      "                await asyncio.sleep(delay)",
      "                continue",
      "            if result.status == 'completed' and result.exchange_token:",
      "                return result.exchange_token",
      "            raise BrowserSignInError('Browser sign-in ' + str(result.status) + ((': ' + result.message) if result.message else '') + '.', code=BrowserSignInErrorCode.UNKNOWN_STATE)",
      "        raise BrowserSignInError('Browser sign-in timed out.', code=BrowserSignInErrorCode.TIMED_OUT)",
      "",
      "    async def run():",
      "        gateway = HttpBrowserSignInGateway(",
      "            browser_base_url=provider.browser_auth_base_url,",
      "            api_base_url=provider.browser_auth_api_base_url,",
      "        )",
      "        service = BrowserSignInService(gateway)",
      "        try:",
      "            attempt = await service.start_attempt()",
      "            emit('C8O_SIGN_IN_URL', attempt.sign_in_url)",
      "            emit('C8O_SIGN_IN_EXPIRES_AT', attempt.expires_at.isoformat())",
      "            if os.environ.get('C8O_VIBE_OPEN_BROWSER') == '1':",
      "                try:",
      "                    import webbrowser",
      "                    emit('C8O_BROWSER_OPENED', str(webbrowser.open(attempt.sign_in_url)))",
      "                except Exception as exc:",
      "                    emit('C8O_BROWSER_OPEN_FAILED', str(exc))",
      "            exchange_token = await wait_for_completion(gateway, attempt)",
      "            return await gateway.exchange(attempt.process_id, exchange_token, attempt.code_verifier)",
      "        finally:",
      "            await service.aclose()",
      "",
      "    try:",
      "        api_key = asyncio.run(run())",
      "    except BrowserSignInError as exc:",
      "        cause = exc.__cause__",
      "        emit('C8O_LOGIN_ERROR', str(exc) + (' (' + type(cause).__name__ + ': ' + str(cause) + ')' if cause is not None else ''))",
      "        return 4",
      "    except Exception as exc:",
      "        emit('C8O_LOGIN_ERROR', type(exc).__name__ + ': ' + str(exc))",
      "        return 4",
      "    if not api_key:",
      "        emit('C8O_LOGIN_ERROR', 'Sign-in completed without an API key')",
      "        return 4",
      "    try:",
      "        write_env(pathlib.Path(home) / '.env', env_key, api_key)",
      "    except OSError as exc:",
      "        emit('C8O_LOGIN_ERROR', 'Unable to store the API key: ' + str(exc))",
      "        return 5",
      "    emit('C8O_LOGIN_COMPLETED', env_key)",
      "    return 0",
      "",
      "",
      "if __name__ == '__main__':",
      "    sys.exit(main())",
      ""
    ].join("\n");
  }

  function ensureVibeLoginScript(installDir) {
    var script = new File(installDir, VIBE_LOGIN_SCRIPT_NAME);
    var source = vibeLoginScriptSource();
    var current = "";
    try { current = script.isFile() ? readTextFile(script) : ""; } catch (_ignoreVibeLoginScriptRead) {}
    if (current !== source) {
      ensureDirectory(script.getParentFile());
      writeTextFile(script, source);
    }
    return filePath(script);
  }

  function vibeLoginOptions(options) {
    options = optionsWithRequestFallbacks(options || {});
    var copy = {};
    for (var key in options) {
      if (Object.prototype.hasOwnProperty.call(options, key)) {
        copy[key] = options[key];
      }
    }
    copy.vibeHome = "";
    copy.agentHome = "";
    copy.vibeHomeScope = "user";
    copy.homeScope = "user";
    copy.userId = trim(options.userId) || contextUserId() || "studio";
    return copy;
  }

  function vibeLoginKey(homePath) {
    return "vibe-login:" + filePath(new File(homePath));
  }

  function vibeAuthenticationRequiredMessage(profile) {
    return profile === "convertigo"
      ? "Convertigo agent key is required. Provide the LiteLLM virtual key (" + CONVERTIGO_LLM_API_KEY_ENV + ") for this Studio user."
      : "Vibe authentication is required. Configure MISTRAL_API_KEY in the Vibe profile.";
  }

  // Convertigo gateway profile: store the per-user virtual key in the user scoped home.
  C8O.agentBridge.vibeGatewayKeyStore = function (options) {
    options = optionsWithRequestFallbacks(options || {});
    var key = trim(options.gatewayApiKey);
    if (!key.length) {
      return { ok: false, status: "error", error: "gatewayApiKey is required", timestamp: now() };
    }
    var keyOptions = vibeLoginOptions(withVibeProfile(options, "convertigo"));
    var setup = detectRuntimePresence(keyOptions);
    if (!trim(setup.vibeHome).length) {
      return { ok: false, status: "error", error: setup.home && setup.home.error ? setup.home.error : "Managed VIBE_HOME is not available.", timestamp: now() };
    }
    writeEnvFileValue(new File(setup.vibeHome, ".env"), CONVERTIGO_LLM_API_KEY_ENV, key);
    return {
      ok: true,
      status: "stored",
      home: setup.vibeHome,
      authentication: inspectVibeAuthentication(setup.vibeHome, "convertigo"),
      timestamp: now()
    };
  };

  function vibeLoginRuntime(loginOptions) {
    if (isConvertigoGatewayProfile(loginOptions)) {
      return { ok: false, setup: null, error: "The Convertigo agent mode uses a managed gateway key; browser sign-in does not apply." };
    }
    var setup = detectRuntimePresence(loginOptions);
    var python = setup.python || {};
    if (!python.found || !commandPathStartsWith(python, setup.venvDir)) {
      return { ok: false, setup: setup, error: "Managed Vibe runtime is not available." };
    }
    if (!trim(setup.vibeHome).length) {
      return { ok: false, setup: setup, error: setup.home && setup.home.error ? setup.home.error : "Managed VIBE_HOME is not available." };
    }
    return { ok: true, setup: setup, python: python };
  }

  function publicVibeLogin(entry) {
    var timedOut = expireLoginProcess(entry, AGENT_LOGIN_TIMEOUT_MS);
    var output = loginProcessOutput(entry);
    var alive = processAlive(entry.process);
    var exitCode = loginProcessExitCode(entry, alive);
    var completed = output.indexOf("C8O_LOGIN_COMPLETED") !== -1;
    var urlMatch = output.match(/C8O_SIGN_IN_URL\s+(\S+)/);
    var errorMatch = output.match(/C8O_LOGIN_ERROR\s+([^\n]*)/);
    var authentication = alive ? null : inspectVibeAuthentication(entry.home);
    var authenticated = !alive && completed && authentication !== null && authentication.configured === true;
    var error = "";
    if (!alive && !authenticated) {
      error = timedOut ? "Vibe browser sign-in timed out." : (errorMatch ? trim(errorMatch[1]) : (completed ? "Vibe stored the API key but the managed VIBE_HOME still reports no credentials." : trim(output) || ("Vibe browser sign-in exited with code " + exitCode)));
    }
    return {
      ok: alive || authenticated,
      status: alive ? "waiting_for_login" : (authenticated ? "authenticated" : "error"),
      running: alive,
      authenticated: authenticated,
      home: entry.home,
      verificationUrl: urlMatch ? trim(urlMatch[1]) : "",
      message: alive ? "Waiting for Mistral browser authentication." : (authenticated ? "Vibe authentication completed." : "Vibe authentication did not complete."),
      error: error,
      exitCode: exitCode,
      startedAt: Number(entry.startedAt || 0),
      timestamp: now()
    };
  }

  C8O.agentBridge.vibeLoginStatus = function (options) {
    var loginOptions = vibeLoginOptions(options);
    var runtime = vibeLoginRuntime(loginOptions);
    if (!runtime.ok) {
      return { ok: false, status: "missing", error: runtime.error, timestamp: now() };
    }
    var home = runtime.setup.vibeHome;
    var entry = providerLoginRegistry().get(vibeLoginKey(home));
    if (entry === null || typeof entry === "undefined") {
      var authentication = inspectVibeAuthentication(home);
      return {
        ok: authentication.configured === true,
        status: authentication.configured === true ? "authenticated" : "login_required",
        running: false,
        authenticated: authentication.configured === true,
        authentication: authentication,
        timestamp: now()
      };
    }
    var status = publicVibeLogin(entry);
    if (status.authenticated === true) {
      status.authentication = inspectVibeAuthentication(home);
    }
    return status;
  };

  C8O.agentBridge.vibeLoginStart = function (options) {
    var loginOptions = vibeLoginOptions(options);
    var runtime = vibeLoginRuntime(loginOptions);
    if (!runtime.ok) {
      return { ok: false, status: "missing", error: runtime.error, timestamp: now() };
    }
    var setup = runtime.setup;
    var home = setup.vibeHome;
    ensureDirectory(new File(home));
    var key = vibeLoginKey(home);
    var registry = providerLoginRegistry();
    var existing = registry.get(key);
    if (existing !== null && typeof existing !== "undefined" && processAlive(existing.process)) {
      return publicVibeLogin(existing);
    }
    var authentication = inspectVibeAuthentication(home);
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
    var script = ensureVibeLoginScript(setup.installDir);
    var stdoutFile = File.createTempFile("c8o-vibe-login-out-", ".log");
    var stderrFile = File.createTempFile("c8o-vibe-login-err-", ".log");
    var env = {
      VIBE_HOME: home,
      PYTHONUNBUFFERED: "1",
      PYTHONIOENCODING: "utf-8"
    };
    if (isWindows()) {
      // Like Claude Code on Windows, let the helper open the default browser itself;
      // the Assistant still receives the URL and may open it too.
      env.C8O_VIBE_OPEN_BROWSER = "1";
    }
    var nodePath = nodeRuntimeSearchPath(loginOptions);
    if (nodePath.length) {
      env.PATH = nodePath + String(File.pathSeparator) + String(System.getenv("PATH") || "");
    }
    var pb = new ProcessBuilder(toJavaList([runtime.python.path, script]));
    applyEngineProxyEnvironment(pb.environment(), "https://console.mistral.ai");
    envObjectToMap(pb.environment(), env);
    pb.directory(new File(setup.workspaceRoot));
    pb.redirectOutput(stdoutFile);
    pb.redirectError(stderrFile);
    var entry = {
      provider: "vibe",
      process: pb.start(),
      home: home,
      stdoutFile: stdoutFile,
      stderrFile: stderrFile,
      startedAt: now()
    };
    registry.put(key, entry);
    return publicVibeLogin(entry);
  };
