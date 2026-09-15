# Bridge Contract

Le contrat initial est expose par le projet Convertigo dedie
`lib_ConvertigoAgentBridge`. `lib_ConvertigoMCP` reste uniquement le serveur MCP que
l'agent peut appeler sur :

```text
http://localhost:18082/convertigo/api/mcp
```

Les clients Studio Eclipse, Studio Web ou NoCode peuvent consommer le bridge en
HTTP classique. Le stream est un long-poll avec curseur, sans WebSocket.

## Endpoint HTTP

Dans l'etat actuel, les appels directs ajoutent `__connector=void` :

```text
http://localhost:18082/convertigo/projects/lib_ConvertigoAgentBridge/.json?__connector=void&__sequence=<sequence>
```

Ce connecteur ne sert qu'a satisfaire la resolution HTTP du moteur Convertigo.
Il ne porte aucune logique metier.

## Cycle minimal

Verifier ou installer Python dans le workspace Convertigo :

```json
{
  "__connector": "void",
  "__sequence": "agent_python_setup",
  "install": "true"
}
```

Verifier le runtime Vibe :

```json
{
  "__connector": "void",
  "__sequence": "agent_vibe_setup",
  "install": "false",
  "configure": "false"
}
```

Installer/configurer Vibe dans `<workspace>/agents/vibe` si besoin :

```json
{
  "__connector": "void",
  "__sequence": "agent_vibe_setup",
  "install": "true",
  "configure": "true",
  "mcpEndpoint": "http://localhost:18082/convertigo/api/mcp"
}
```

`agent_vibe_setup install=true` appelle le meme bootstrap Python que
`agent_python_setup`, meme si un Python systeme est disponible. Le runtime
Python gere est installe sous `<workspace>/agents/runtimes/python`, puis le
venv Vibe sous `<workspace>/agents/vibe/.venv` est cree ou migre avec ce
runtime.

Les installations serveur peuvent utiliser un miroir interne :

```json
{
  "__connector": "void",
  "__sequence": "agent_python_setup",
  "install": "true",
  "pythonAssetUrlPrefix": "https://mirror.example/pbs/{tag}",
  "pythonArchiveSha256": "..."
}
```

Les chemins de configuration (`installDir`, `pythonInstallDir`, `cwd`) sont
relatifs au workspace Convertigo quand ils ne sont pas absolus.

Demarrer une session ACP :

```json
{
  "__connector": "void",
  "__sequence": "agent_vibe_start",
  "handle": "agent-vibe-acp-1",
  "cwd": "/Users/nicolas/git",
  "vibeHome": "/Users/nicolas/git/agents/vibe/.vibe-home",
  "mcpEndpoint": "http://localhost:18082/convertigo/api/mcp",
  "env": "{\"MISTRAL_API_KEY\":\"...\"}",
  "ttlSeconds": "3600"
}
```

Demarrer une session ACP avec isolation par conversation :

```json
{
  "__connector": "void",
  "__sequence": "agent_vibe_start",
  "handle": "agent-vibe-acp-1",
  "cwd": "/Users/nicolas/git",
  "vibeHomeScope": "conversation",
  "userId": "user stable id",
  "conversationId": "conversation stable id",
  "projectId": "project stable id",
  "credentialsPolicy": "user-home"
}
```

Envoyer un prompt sans bloquer :

```json
{
  "__connector": "void",
  "__sequence": "agent_vibe_prompt",
  "handle": "agent-vibe-acp-1",
  "prompt": "Inspecte le workspace Convertigo et resume le projet courant.",
  "waitForCompletion": "false"
}
```

Lire le stream :

```json
{
  "__connector": "void",
  "__sequence": "agent_events",
  "handle": "agent-vibe-acp-1",
  "cursor": "0",
  "limit": "100",
  "waitMs": "1000"
}
```

Arreter :

```json
{
  "__connector": "void",
  "__sequence": "agent_vibe_close",
  "handle": "agent-vibe-acp-1"
}
```

## Codex resident

Le bridge utilise maintenant Codex en mode resident par defaut, via :

```text
codex app-server --listen stdio://
```

`agent_codex_start` lance ce process, initialise le protocole JSON-RPC
app-server, puis cree ou reprend un thread Codex. `agent_codex_prompt` n'appelle
plus `codex exec` en mode par defaut ; il envoie un `turn/start` au process
stdio deja vivant.

`agent_codex_start` est idempotent pour un handle vivant. Si le handle existe
encore dans le registry serveur et que son process est vivant, la sequence
retourne `status: "already_running"` et reutilise le meme app-server. Cette
propriete permet a l'Assistant de prechauffer Codex quand l'utilisateur reprend
une conversation, avant le premier prompt.

Le mode historique reste disponible en fallback avec `codexRuntimeMode=exec`.
Dans ce cas, chaque prompt repasse par `codex exec --json` ou
`codex exec resume --json`.

## Claude Code resident

`agent_claude_start` lance :

```text
claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-mode bypassPermissions --mcp-config <home>/convertigo-mcp.json --strict-mcp-config [--model <alias>] [--effort <level>] [--resume <sessionId>]
```

`agent_claude_prompt` ecrit un message `{"type":"user","message":{...}}` sur le
stdin du process vivant. `agent_claude_start` est idempotent pour un handle
vivant (`already_running`) et redemarre le process avec `--resume` quand le
modele, l'effort, le mode reveal ou le jeton MCP change. L'id de session Claude
est expose dans `state.sessionId` et repris par l'Assistant comme
`externalSessionId`.

## Semantique des evenements

Chaque evenement contient :

- `index` : curseur strictement croissant par process.
- `at` : timestamp epoch millis.
- `type` : type normalise de l'evenement.
- `data` : payload de l'evenement.

`agent_events` retourne le prochain curseur a utiliser. Le client rappelle la
sequence avec ce curseur pour recevoir uniquement les nouveaux evenements.

Types normalises principaux :

- `system/start`, `system/exit`, `system/closed`
- `acp/request`, `acp/response`, `acp/session`, `acp/error`
- `reasoning/chunk`
- `answer/chunk`
- `tool/start`, `tool/update`
- `usage/update`
- `plan/update`
- `commands/update`
- `permission/request`, `permission/selected`

Les notifications ACP `agent_thought_chunk`, `agent_message_chunk`,
`tool_call`, `tool_call_update`, `usage_update`,
`available_commands_update` et `plan` sont converties en evenements pollables.

Dans ce prototype, les demandes ACP `session/request_permission` sont traitees
automatiquement en selectionnant l'option `allow_once` ou une option
equivalente quand elle existe.

## Registry serveur

Le registry des process est stocke dans `context.server` sous une cle propre au
projet. Les handles ne sont donc pas serialises en base et disparaissent au
redemarrage du moteur Convertigo.

Un handle courant est aussi stocke dans la session HTTP avec
`context.httpSession`. Une UI peut donc demarrer un process, puis appeler
`agent_vibe_prompt` et `agent_events` sans repasser explicitement le handle tant
que la session HTTP reste la meme.

Pour Codex app-server, le bridge ecrit en plus un fichier PID par handle sous :

```text
<workspaceRoot>/agents/codex/app-server-pids/<handle>.json
```

Ce fichier contient le PID du wrapper Node, la commande, le workspace root, le
handle et le TTL. Il sert uniquement au nettoyage des process orphelins quand le
registry `context.server` a ete perdu, par exemple apres un reload projet ou un
redemarrage partiel. Les PID files ne remplacent pas le registry memoire pour le
flux normal.

## Isolation et credentials

Le `VIBE_HOME` est resolu avant le demarrage du process :

- `vibeHome` explicite : utilise tel quel.
- `vibeHomeScope=shared` : `<workspace>/agents/vibe/.vibe-home`.
- `vibeHomeScope=user` : home dedie a `userId`.
- `vibeHomeScope=conversation` : home dedie a `conversationId`, optionnellement
  sous `userId` et `projectId`.

Les identifiants ne sont pas recopies en clair dans les chemins ; le bridge
utilise des UUID stables derives des valeurs fournies.

Le setup copie `~/.vibe/.env` vers le `VIBE_HOME` scope quand il existe. Les
credentials sont ensuite choisis avec `credentialsPolicy`; la valeur par
defaut est `vibe-home` :

- `explicit` : variables fournies dans `env` uniquement.
- `user-home` : lit `~/.vibe/.env` et injecte les variables absentes.
- `vibe-home` : lit `<VIBE_HOME>/.env`.
- `auto` : lit d'abord `<VIBE_HOME>/.env`, puis `~/.vibe/.env`.

Le status retourne les noms de variables disponibles, jamais leurs valeurs.

## Nettoyage

`agent_sweep_expired` ferme les process dont l'inactivite depasse leur TTL, ou
le seuil `maxIdleSeconds` fourni a l'appel. Cette sequence est faite pour etre
appelee plus tard par un scheduler Convertigo.

Au demarrage Codex, `agent_codex_start` balaie aussi les PID files Codex et
ferme les app-servers orphelins expires. Un process est conserve si son PID est
encore reference par une entree vivante du registry. Quand un handle est ferme
normalement avec `agent_codex_close`, le PID file correspondant est supprime.

Les runtimes Python ne sont pas supprimes par `agent_sweep_expired`. Ils sont
des outils partages du workspace, comme le cache Node.js du moteur.

## Validation locale

Validation faite le 2026-06-15 via HTTP `localhost:18082` :

- `agent_vibe_setup install=false configure=false` retourne `status: "ready"`.
- `agent_vibe_start` avec `MISTRAL_API_KEY=dummy` valide le handshake ACP
  `initialize` + `session/new`.
- Le resultat `session/new.configOptions` alimente le catalogue de modeles et
  niveaux de raisonnement du provider Vibe; les changements sont appliques par
  `session/set_config_option` et caches par `VIBE_HOME`.
- Le setup des homes geres utilise `glm-5-2` fourni nativement par Vibe.
  L'ancien preset gere
  `zai-glm-5-2` est retire lors de la migration pour eviter un doublon dans
  `configOptions`.
- Un home explicite isole sous `agents/vibe/homes/test-explicit/.vibe-home`
  valide aussi le handshake ACP.
- `agent_events` retourne les evenements initiaux du process Vibe ACP.
- `agent_vibe_close` ferme le process.
- `agent_sweep_expired` supprime les handles abandonnes.
