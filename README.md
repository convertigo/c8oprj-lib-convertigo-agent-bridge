# Convertigo Agent Bridge

`lib_ConvertigoAgentBridge` is Tigo's local runtime bridge for Convertigo
Studio. It manages workspace-local OpenAI Codex, Mistral Vibe, and Anthropic
Claude Code runtimes,
persistent agent processes, isolated homes, conversations, events, and local
viewer integration.

## Highlights

- Installs and updates managed Codex, Vibe, Claude Code, Python, and Node.js
  runtimes while honoring Convertigo proxy settings.
- Keeps long-running Codex and Vibe processes behind a stable HTTP/polling
  contract used by the Tigo Assistant.
- Isolates homes and conversations inside the Convertigo workspace.
- Receives only opaque handles for protected MCP credentials. Managed bearer
  tokens remain in server memory and are never written to runtime profiles,
  responses, logs, or conversation records.
- Restarts resident agents transparently when a managed credential is renewed.

## Requirements

- Convertigo Studio 8.4.4 or newer when used by the Tigo local Agent stack.
- `lib_ConvertigoMCP` for structured Convertigo authoring.
- `lib_ConvertigoAssistant` for the user-facing Tigo experience.

The project is installed and updated automatically by Tigo's Agent stack
onboarding. It is a companion service and is not normally invoked directly by
end users.

## Technical reference

Projet Convertigo dedie a l'integration locale des agents IA dans Convertigo
Studio.

L'objectif est d'exposer a l'assistant une interface HTTP/polling simple, sans
WebSocket, capable de piloter un agent CLI persistant comme `vibe-acp`. Le
projet `lib_ConvertigoMCP` reste le serveur MCP appele par l'agent, mais il ne porte
pas le wrapper d'agent.

## Etat iteration 1

Le projet `lib_ConvertigoAgentBridge` est un projet Convertigo autonome place dans :

```text
/Users/nicolas/git/c8oprj-lib-convertigo-agent-bridge
```

Il expose les sequences publiques suivantes :

- `agent_python_setup` : verifie ou installe un runtime Python local au
  workspace Convertigo.
- `agent_codex_setup` : verifie ou installe le runtime Codex local.
- `agent_codex_start` : lance ou reutilise un `codex app-server` resident en
  stdio et cree ou reprend un thread Codex.
- `agent_codex_prompt` : envoie un prompt au thread Codex resident.
- `agent_codex_close` : ferme le handle Codex et arrete son app-server.
- `agent_vibe_setup` : verifie ou installe le runtime Vibe local.
- `agent_vibe_start` : lance `vibe-acp`, fait `initialize`, puis cree une
  session ACP.
- `agent_vibe_prompt` : envoie un prompt a la session ACP.
- `agent_events` : lit les evenements normalises par long-poll HTTP.
- `agent_status` : retourne les process vivants en memoire serveur, avec le PID
  quand le runtime l'expose.
- `agent_vibe_close` : ferme la session et arrete le process.
- `agent_sweep_expired` : nettoie les process abandonnes.
- `agent_claude_setup` : verifie ou installe le runtime Claude Code local.
- `agent_claude_start` : lance ou reutilise un process resident `claude -p`
  en stream-json et reprend une session Claude Code si un id est fourni.
- `agent_claude_prompt` : envoie un prompt au process Claude Code resident.
- `agent_claude_close` : ferme le handle Claude Code et arrete son process.

Les process sont gardes en memoire serveur via `context.server.set/get`. Le
handle courant est memorise dans la session HTTP pour permettre au chatbot de
continuer a appeler `agent_events` ou `agent_vibe_prompt` sans repasser le
handle a chaque requete.

Codex utilise `codex app-server --listen stdio://` par defaut. Le handle est
resident et `agent_codex_start` est idempotent : si le process existe deja, la
sequence retourne `already_running` au lieu de relancer Codex. Cela permet au
projet Assistant de prechauffer le serveur quand l'utilisateur reprend une
conversation.

Les app-servers Codex ont aussi un fichier PID sous
`<workspace>/agents/codex/app-server-pids/<handle>.json`. Ce fichier permet de
nettoyer les process orphelins lorsque le registry memoire Convertigo est perdu.
`agent_codex_close` supprime le fichier PID ; `agent_codex_start` et
`agent_sweep_expired` peuvent fermer les PID expires qui ne sont plus lies a un
handle vivant.

## Appels HTTP

Les appels HTTP directs doivent passer le connecteur minimal `void`. Si
`mcpEndpoint` est vide, le bridge calcule l'endpoint depuis l'URL Convertigo
courante du moteur. Il ajoute `/api/flow-mcp` pour le profil `flow` et
`/api/mcp` pour les profils legacy/no-code. Le profil Flow est detecte depuis
le projet selectionne, ou peut etre force avec `agentProfile=flow`. En local,
les ports habituels sont `18080` en Studio et `28080` en serveur.

L'endpoint Convertigo MCP est protege par bearer token. Pour le profil
generaliste, l'Assistant authentifie fournit au Bridge un handle opaque vers un
jeton gere de courte duree. Le Bridge resout ce secret uniquement en memoire,
configure `CONVERTIGO_MCP_TOKEN` dans l'environnement Codex ou Vibe et redemarre
le processus resident lors d'un renouvellement. Le jeton brut n'est jamais
ecrit dans les fichiers de configuration, les reponses HTTP ou les journaux.
Le profil No Code conserve son jeton C8OForms limite aux outils No Code via
`C8O_NOCODE_MCP_TOKEN`.

Pour Codex, le profil Flow delegue son bootstrap a
`lib_flow_mcp._setupCodex`. Le home scope recoit alors le serveur nomme
`convertigo-flow` et trois skills : l'orchestrateur `convertigo-flow-mcp`, le
specialiste backend persistant `convertigo-flow-backend` et le specialiste
frontend persistant `convertigo-flow-frontend-svelte`. Une absence de l'outil
MCP nomme doit etre signalee comme une erreur de configuration; `curl` et le
JSON-RPC ecrit a la main ne sont pas des fallbacks d'authoring.

Pour les exemples :

```text
BASE_URL=http://localhost:18080/convertigo
BRIDGE_URL=$BASE_URL/projects/lib_ConvertigoAgentBridge/.json
```

Exemple de check runtime :

```bash
curl -sS "$BRIDGE_URL?__connector=void&__sequence=agent_vibe_setup&install=false&configure=false"
```

Exemple d'installation Python workspace-local :

```bash
curl -sS "$BRIDGE_URL?__connector=void&__sequence=agent_python_setup&install=true"
```

Exemple d'installation Codex workspace-local :

```bash
curl -sS "$BRIDGE_URL?__connector=void&__sequence=agent_codex_setup&install=true"
```

Exemple de demarrage ACP :

```bash
curl -sS --get \
  --data-urlencode '__connector=void' \
  --data-urlencode '__sequence=agent_vibe_start' \
  --data-urlencode 'handle=test-vibe-wrapper' \
  --data-urlencode 'cwd=/Users/nicolas/git' \
  --data-urlencode 'vibeHome=/Users/nicolas/git/agents/vibe/.vibe-home' \
  --data-urlencode 'env={"MISTRAL_API_KEY":"dummy"}' \
  "$BRIDGE_URL"
```

Le streaming cote UI se fait par polling :

```bash
curl -sS --get \
  --data-urlencode '__connector=void' \
  --data-urlencode '__sequence=agent_events' \
  --data-urlencode 'handle=test-vibe-wrapper' \
  --data-urlencode 'cursor=0' \
  --data-urlencode 'waitMs=1000' \
  "$BRIDGE_URL"
```

## Vibe ACP

La voie produit pour Vibe est ACP sur stdio, pas un wrapper batch
`vibe --continue`. ACP conserve le contexte dans le process vivant et remonte
les updates de raisonnement, reponse, outils, usage et permissions en temps
reel.

Le bootstrap Vibe fait :

1. Detection des runtimes geres et des installations externes utiles au
   diagnostic ou a la migration.
2. Avec `install=true`, installation ou reutilisation du Python standalone
   gere dans `<workspace>/agents/runtimes/python/<runtime>`. Un Python systeme
   ou Homebrew ne remplace pas ce runtime.
3. Creation de `<workspace>/agents/vibe/.venv` avec ce Python gere, migration
   automatique d'un ancien venv systeme, puis installation de `mistral-vibe`
   via `pip`.
4. Avec `configure=true`, ecriture de
   `<workspace>/agents/vibe/.vibe-home/config.toml` avec le MCP Convertigo en
   HTTP. Si `mcpEndpoint` est vide, il est calcule depuis l'endpoint Convertigo
   courant.
5. Synchronisation de `~/.vibe/.env` vers le `VIBE_HOME` scope quand le fichier
   existe, comme les fichiers d'authentification Codex sont synchronises vers
   chaque `CODEX_HOME` gere.
6. Demarrage du `vibe-acp` gere avec ce `VIBE_HOME`, puis handshake ACP
   `initialize` + `session/new`.
7. Lecture du catalogue `configOptions` retourne par la session ACP. Les
   modeles routes par le compte Vibe, leurs libelles et les niveaux de
   raisonnement sont exposes a l'Assistant et caches par `VIBE_HOME` pendant
   six heures. Un modele choisi est applique au process vivant avec
   `session/set_config_option`, sans regenerer une definition TOML approximative.
8. Utilisation du modele GLM 5.2 natif de Vibe (`glm-5-2`) et migration de
   l'ancien preset gere `zai-glm-5-2` pour eviter les doublons.

Vibe charge aussi sa config `config.toml`; le champ ACP `mcpServers` seul ne
suffit pas. Le setup local configure donc explicitement le MCP dans le
`VIBE_HOME` utilise par le process.

## Playwright MCP pour Claude et Vibe

Le meme raccord viewer que Codex est applique aux providers Claude et Vibe :

- `agent_claude_start` et `agent_vibe_start` reservent un port de debug JxBrowser
  stable par conversation (bail sous `<workspace>/agents/codex/viewer-debug-ports`,
  partage entre providers) et basculent le home gere en scope `conversation`.
- Le header `X-Convertigo-Viewer-Debug-Port` est envoye au MCP Convertigo pour
  que `mobile-builder-open` ouvre le viewer du Studio sur ce port.
- `@playwright/mcp` est installe dans le prefixe npm du provider
  (`<workspace>/agents/claude/npm`, `<workspace>/agents/vibe/npm`) avec
  `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, puis declare comme serveur MCP stdio
  `playwright` avec `--cdp-endpoint http://127.0.0.1:<port> --shared-browser-context` :
  dans `convertigo-mcp.json` pour Claude, dans `config.toml` (`[[mcp_servers]]`,
  `transport = "stdio"`) pour Vibe.
- Un changement d'endpoint viewer ou de jeton redemarre le process resident.

## Runtime Python workspace-local

`agent_python_setup` installe Python dans le workspace Convertigo, pas dans le
projet. Par defaut :

```text
<workspace>/agents/runtimes/python/cpython-3.12.13-20260610-<platform>
```

Avec `install=true`, le setup utilise en priorite le Python gere du workspace
et le telecharge s'il est absent, meme si un Python systeme est disponible.
Une installation externe reste visible pour le diagnostic et peut etre
explicitement autorisee avec `workspaceInstallFirst=false`. L'archive
`python-build-standalone` est telechargee via le client HTTP du moteur
Convertigo. Le bridge applique aussi le proxy a chaque requete et reevalue un
eventuel PAC apres chaque redirection. Le proxy basic est authentifie et le mode
NTLM manuel passe par le bridge NTLM local de Convertigo. Le telechargement peut
etre remplace par :

- `pythonArchiveUrl` : URL directe de l'archive.
- `pythonAssetUrlPrefix` ou `pythonMirrorBaseUrl` : prefixe d'un miroir
  interne, avec support de `{tag}`.
- `pythonArchiveSha256` : controle optionnel de checksum.
- `allowPythonDownload=false` : mode diagnostic/offline, sans telechargement.

Les chemins optionnels (`installDir`, `pythonInstallDir`, `cwd`) peuvent etre
absolus ou relatifs. Quand ils sont relatifs, ils sont resolus depuis le
workspace Convertigo.

Cette installation est partageable par les providers. Les venvs restent separes
par agent, par exemple `<workspace>/agents/vibe/.venv`.

Les commandes externes lancees par le bridge recoivent aussi la configuration
proxy du moteur Convertigo. Cela couvre `pip`, les controles PyPI, `npm`, puis
les processus Vibe et Codex eux-memes pour leurs appels distants. Le bridge
propage `HTTP_PROXY`, `HTTPS_PROXY`, leurs variantes minuscules, `NO_PROXY`, les
variables npm et `PIP_PROXY`. L'authentification basic est encodee dans l'URL et
le mode NTLM manuel utilise le proxy local `NtlmConnectProxyBridge`. En mode PAC,
le proxy est evalue pour la destination principale (PyPI, registre npm, OpenAI
ou Mistral).

## Runtime Codex workspace-local

`agent_codex_setup` detecte d'abord une CLI Codex existante (`codexPath`, puis
`<workspace>/agents/codex/npm/node_modules/.bin/codex`, puis les chemins usuels
du poste). Si aucune CLI n'est trouvee et que `install=true`, il installe le
package npm `@openai/codex@latest` dans :

```text
<workspace>/agents/codex/npm
```

L'installation utilise le mecanisme Node/npm du moteur Convertigo
(`ProcessUtils`), donc avec le repertoire Node du workspace et la configuration
proxy du serveur. Les options principales sont :

- `nodeVersion`, `nodeDir`, `npmPath` : overrides Node/npm.
- `allowNodeDownload=false` : mode diagnostic/offline, sans telechargement
  Node.
- `codexPackage`, `codexVersion` : package npm et version a installer.
- `playwrightMcpPackage`, `playwrightMcpVersion` : package Playwright MCP a
  installer a cote de la CLI Codex. Par defaut, le bridge installe
  `@playwright/mcp@latest`.
- `forceCodexInstall=true` : force la reinstall meme si une CLI est deja
  detectee.
- `forcePlaywrightInstall=true` : force la reinstall Playwright MCP.
- `skipPlaywrightInstall=true` : desactive l'installation Playwright MCP.

Le runtime Codex gere installe aussi `@playwright/mcp` dans le meme prefixe npm,
avec `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`. Aucun navigateur n'est telecharge par
defaut : Playwright MCP sert a s'attacher au JxBrowser visible expose par le
Studio via CDP (`browserDebugUrl`, `browserDevToolsWebSocketUrl` ou
`playwrightCdpEndpoint`). Le bridge configure alors le `codex-home/config.toml`
gere avec un serveur MCP Playwright stable. Pour un home de conversation,
l'endpoint CDP est ecrit dans les arguments du serveur Playwright MCP de ce home
et rafraichi a chaque viewer. Pour un home partage force, Playwright MCP reste
desactive par defaut afin de ne pas ouvrir un navigateur separe avec un endpoint
stale.

```toml
# The Studio JxBrowser CDP endpoint is written here because this Codex home is viewer-scoped.
# If a shared/user home is forced, Playwright MCP stays disabled to avoid opening an external browser.
[mcp_servers.playwright]
command = "npx"
args = ["--prefix", "<workspace>/agents/codex/npm", "playwright-mcp", "--cdp-endpoint", "http://localhost:12345", "--shared-browser-context"]
startup_timeout_sec = 30
enabled = true
```

Les agents doivent utiliser les outils MCP Playwright exposes par Codex. Ils ne
doivent pas lancer de scripts ad hoc avec `require("playwright")` ni piloter un
navigateur par CLI hors du serveur MCP. Si le premier etat visible par les
outils navigateur est `about:blank` avant que `mobile-builder-open` ne retourne
`browserControlReady:true`, l'agent doit traiter le viewer comme encore en
chauffe et repoller le builder. Si les outils MCP Playwright/browser ne sont pas
exposes ou ne ciblent toujours pas le JxBrowser courant apres readiness, l'agent
doit signaler un probleme de configuration au lieu de contourner avec Node, CDP
brut ou un navigateur separe.

Pour une application Flow Svelte, le meme raccord Playwright/CDP est conserve,
mais la preparation du viewer et sa readiness viennent du capability pack Flow,
pas du workflow legacy `mobile-builder-open`. Le bridge ne connait volontairement
pas les noms des outils Flow qui realisent ces operations.

L'installation de la CLI ne configure pas l'authentification Codex. L'utilisateur
doit toujours disposer d'une session Codex valide dans le `CODEX_HOME` choisi,
ou utiliser le home Codex par defaut du poste.

## Isolation CODEX_HOME

Par defaut, Codex utilise un home par utilisateur sous
`<workspace>/agents/codex/homes/users`. Quand un endpoint JxBrowser est fourni
pour Playwright MCP et qu'aucun scope n'est force par le client, le bridge passe
sur un home par conversation afin d'isoler la configuration runtime du viewer.
Les clients peuvent toujours forcer `codexHomeScope=user`, `conversation`,
`shared`, `default` ou fournir `codexHome` explicitement.

## Isolation VIBE_HOME

Le projet bridge est commun a plusieurs agents et plusieurs frontaux, mais
chaque process peut utiliser un `VIBE_HOME` separe. Le client choisit avec
`vibeHomeScope` :

- `shared` : home commun historique, `<workspace>/agents/vibe/.vibe-home`.
- `user` : home par utilisateur, sous `<workspace>/agents/vibe/homes/users`.
  `userId` est requis si le contexte Convertigo ne fournit pas deja un
  utilisateur authentifie.
- `conversation` : home par conversation, sous
  `<workspace>/agents/vibe/homes/conversations` ou sous le home utilisateur si
  `userId` est fourni. Si `conversationId` est vide, un id est genere et garde
  dans la session HTTP.
- `vibeHome` explicite : prioritaire sur le scope, utile pour tests ou
  integrations avancees.

`projectId` peut etre fourni pour ajouter un niveau projet dans les homes
`user` et `conversation`. Les identifiants utilisateur/projet/conversation sont
hashes dans les chemins afin de ne pas exposer directement un email ou login
dans le filesystem.

Le setup synchronise `~/.vibe/.env` vers chaque `VIBE_HOME` gere. Le demarrage
utilise donc `vibe-home` par defaut et accepte aussi `credentialsPolicy` :

- `explicit` : uniquement les variables passees dans `env`.
- `user-home` : injecte les variables trouvees dans `~/.vibe/.env`.
- `vibe-home` : injecte les variables trouvees dans le `.env` du `VIBE_HOME`
  choisi.
- `auto` : tente `vibe-home`, puis `user-home`.

Les valeurs des variables ne sont jamais retournees dans les evenements ou les
status, seuls les noms de variables injectees le sont.

### Connexion navigateur Mistral (Vibe)

Vibe n'expose son sign-in navigateur que dans l'onboarding interactif
(`vibe --setup`) ou via ACP `authenticate`. Le bridge pilote le meme service
Python sans terminal : `agent_vibe_setup` avec `login=true` (alias `vibeLogin`,
`forceLogin`) execute `agents/vibe/c8o_vibe_browser_login.py` avec le Python du
venv gere et `VIBE_HOME` = home scope `user`. Le script cree la tentative de
connexion Mistral AI Studio, ecrit `C8O_SIGN_IN_URL <url>` (repris dans
`verificationUrl`), attend la confirmation navigateur puis enregistre
`MISTRAL_API_KEY` dans `<VIBE_HOME>/.env` (mode 600). La cle n'apparait jamais
dans la sortie du bridge. `loginStatus=true` suit le processus
(`waiting_for_login`, `authenticated`, `error`), abandonne apres 15 minutes.
Les homes scope `conversation` recuperent ensuite ce `.env` par le bootstrap
(source la plus recente entre le home scope `user` et `~/.vibe`). Sans
identifiants, `authentication.action` vaut `vibe_login` ; une cle stockee par
`vibe --setup` dans le trousseau macOS (`ai.mistral.vibe`) est aussi reconnue.

## Validation locale

Validation faite le 2026-08-24 sur le port hotfix local de developpement :

- `agent_vibe_setup install=true configure=true` installe Python 3.12.13 dans
  `agents/runtimes/python`, recree le venv avec ce runtime et detecte `vibe` et
  `vibe-acp` 2.24.3 sous `agents/vibe/.venv`.
- Le `VIBE_HOME` utilisateur recoit une copie de `~/.vibe/.env` sans exposer la
  valeur de la cle dans le payload de demarrage.
- Un `VIBE_HOME` explicite isole sous
  `/Users/nicolas/git/agents/vibe/homes/test-explicit/.vibe-home` est configure
  correctement et passe `initialize` + `session/new`.
- `agent_vibe_start` avec une cle factice `MISTRAL_API_KEY=dummy` passe
  `initialize` et `session/new` sans envoyer de prompt LLM.
- `agent_events` expose les evenements ACP initiaux, dont `acp/request`,
  `acp/response`, `commands/update` et `acp/session`.
- `agent_vibe_close` ferme la session et retire le process de la memoire
  serveur.

## Priorites suivantes

1. Ajouter une route/facade plus propre pour eviter de passer
   `__connector=void` dans les appels assistant.
2. Valider l'installation Python/Vibe sur un serveur sans Python preinstalle.
3. Valider un prompt Vibe ACP bout en bout avec MCP Convertigo actif et une
   vraie authentification Vibe.
4. Declencher `agent_sweep_expired` depuis un scheduler Convertigo.
5. Brancher l'UI assistant locale par polling HTTP.

## Runtime Claude Code workspace-local

`agent_claude_setup` detecte d'abord une CLI Claude Code existante (`claudePath`,
puis `<workspace>/agents/claude/npm/node_modules/.bin/claude`, puis les chemins
usuels du poste). Si aucune CLI n'est trouvee et que `install=true`, il installe
le package npm `@anthropic-ai/claude-code@latest` dans
`<workspace>/agents/claude/npm` avec le Node/npm du moteur Convertigo et la
configuration proxy du serveur.

Le home gere est un `CLAUDE_CONFIG_DIR` visible :
`<workspace>/agents/claude/homes/users/<stable-user-id>/claude-home`. Le bridge
y ecrit `.claude.json` (onboarding deja effectue), `CLAUDE.md` (instructions de
la session Tigo), `convertigo-mcp.json` et les skills geres
`skills/convertigo-studio` et `skills/convertigo-generalist`, synchronises depuis
`lib_ConvertigoMCP._setupClaude` (`configureMcp=false`). Le profil No Code ecrit
`skills/convertigo-nocode`.

Le serveur MCP Convertigo est passe au process avec `--mcp-config
<home>/convertigo-mcp.json --strict-mcp-config`. Le fichier reference
`Authorization = "Bearer ${CONVERTIGO_MCP_TOKEN}"` : la variable est resolue par
Claude Code au demarrage depuis l'environnement injecte par le bridge, le jeton
n'est jamais ecrit sur disque. Un renouvellement de jeton, un changement de
modele, d'effort ou de bundle de skills redemarre le process avec `--resume`.

Le process resident est `claude -p --input-format stream-json --output-format
stream-json --verbose --include-partial-messages --permission-mode
bypassPermissions`. Les evenements stream-json sont normalises : texte en cours
en `answer/chunk` phase `commentary`, `tool_use` / `tool_result` en `tool/start`
et `tool/update`, reponse finale (`result`) en `answer/chunk` phase
`final_answer` puis `turn/end`. Une reponse `Not logged in` devient un
`turn/error` marque `authentication`.

Authentification : comme pour Codex, le bridge copie le fichier
`.credentials.json` du home utilisateur (`~/.claude`) ou du home scope `user`
vers le home gere, ou l'extrait du trousseau macOS (`Claude Code-credentials`).
`ANTHROPIC_API_KEY` et `CLAUDE_CODE_OAUTH_TOKEN` sont acceptes depuis
l'environnement. Sans identifiants, `agent_claude_setup` retourne
`authentication_required` avec `authentication.action = "claude_login"`.

Connexion navigateur : `agent_claude_setup` avec `login=true` (alias
`claudeLogin`, `forceLogin` pour forcer une nouvelle session) lance
`claude auth login` dans le home scope `user`, avec `BROWSER` pointe sur un petit
script (`agents/claude/claude-login-browser.sh`) qui enregistre l'URL OAuth au
lieu d'ouvrir un navigateur ; la reponse expose `verificationUrl` (callback
`localhost` gere par le CLI) que l'Assistant ouvre dans le navigateur de
l'utilisateur, exactement comme `codex login`. Sur Windows le CLI ouvre lui-meme
le navigateur par defaut. `loginStatus=true` suit le processus
(`waiting_for_login`, `authenticated`, `error`) ; a la fin, `claude auth status`
fait foi puis les identifiants sont resynchronises dans le home gere. Le
processus est abandonne apres 15 minutes.

L'automatisation du viewer Studio passe par le serveur Playwright MCP decrit dans
la section dediee. Le pack Flow reste reserve a Codex.
