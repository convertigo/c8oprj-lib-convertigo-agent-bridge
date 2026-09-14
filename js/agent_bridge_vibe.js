// Vibe ACP provider implementation.
// Loaded by vibe_agent_bridge.js after agent_bridge_common.js.
  C8O.agentBridge.vibeSetup = function (options) {
    options = optionsWithRequestFallbacks(options || {});
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
        var expectedPlaywright = vibePlaywrightServer(options);
        var expectedPlaywrightEndpoint = expectedPlaywright === null ? "" : resolvePlaywrightMcpCdpEndpoint(options);
        if (setup.config.selected.valid
            && trim(setup.config.selected.endpoint) === vibeMcpTransportEndpoint(setup.mcpEndpoint)
            && trim(setup.config.selected.bearerTokenEnv) === expectedBearerEnv
            && Number(setup.config.selected.viewerDebugPort || 0) === (expectedBearerEnv.length ? expectedViewerDebugPort : 0)
            && trim(setup.config.selected.playwrightEndpoint) === expectedPlaywrightEndpoint) {
          messages.push("Local VIBE_HOME config reused: " + setup.config.selected.path);
        } else {
          var written = writeLocalVibeConfig(setup.vibeHome, setup.mcpEndpoint, options.model || options.agentModel, options);
          messages.push("Local VIBE_HOME config written: " + written.path + " (" + written.model + ")");
        }
        var presetMigration = migrateManagedVibeConfig(setup.vibeHome);
        if (presetMigration.removed.length) {
          messages.push("Legacy managed Vibe model preset migrated: " + presetMigration.removed.join(", "));
        }
      }
      bootstrap = bootstrapVibeHome(setup.vibeHome);
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
        var fallbackAuthentication = inspectVibeAuthentication(setup.vibeHome);
        var fallbackReady = fallbackAuthentication.configured === true && fallbackSkills.ok !== false;
        if (!fallbackReady) {
          messages.push(fallbackAuthentication.configured === true
            ? "Vibe skill configuration is required before start."
            : "Vibe authentication is required. Configure MISTRAL_API_KEY in the Vibe profile.");
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
    var authentication = inspectVibeAuthentication(setup.vibeHome);
    var skills = installAgentSkills(options, "vibe", setup.vibeHome);
    var skillsReady = skills.ok !== false;
    var ready = runtimeReady && authentication.configured === true && skillsReady;
    if (runtimeReady && authentication.configured !== true) {
      messages.push("Vibe authentication is required. Configure MISTRAL_API_KEY in the Vibe profile.");
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
      started = C8O.agentBridge.vibeStart({
        handle: handle,
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
        return started.providerSettings;
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
