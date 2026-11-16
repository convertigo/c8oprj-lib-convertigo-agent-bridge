// A No Code agent under sandboxed-shell reads public web pages with the Bridge's page reader. Vibe 3 has no web tool of
// its own (its web_search and open_url are Mistral's web_search connector, which needs a Mistral provider and key, and
// the Convertigo gateway does not relay it), while the confined shell already reaches the web: Landlock holds the file
// system only. sandbox/python/c8o_web_read.py prints a page as text, at most 12,000 characters a call, refuses private
// addresses, and the No Code instructions name it under sandboxed-shell only.
// node --test tests/nocode_web_read.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const javaProxy = new Proxy(function(){},{get(_t,p){if(p===Symbol.toPrimitive)return ()=>'';return javaProxy;},apply(){return javaProxy;},construct(){return javaProxy;}});
global.Packages=javaProxy;global.context=javaProxy;global.C8O={agentBridge:{}};
for(const name of ['common','codex','claude','vibe'])vm.runInThisContext(fs.readFileSync(path.join(root,'js/agent_bridge_'+name+'.js'),'utf8'));
const moduleDir = path.join(root, 'sandbox/python');
const reader = path.join(moduleDir, 'c8o_web_read.py');
const python = ['python3', 'python'].find((cmd) => spawnSync(cmd, ['--version']).status === 0);
const noCode = { userId: 'person@example.invalid', conversationId: 'agent-1', agentProfile: 'nocode' };

// runs a Python program with the reader importable as `r`; its stdout parsed as JSON
function py(program, args = []) {
  const run = spawnSync(python, ['-I', '-c', 'import json, sys\nsys.path.insert(0, ' + JSON.stringify(moduleDir) + ')\nimport c8o_web_read as r\n' + program, ...args], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

const PAGE = `<!doctype html><html><head><title>Guide  des
  formulaires</title><meta charset="utf-8"><style>body { color: red }</style><script>var secret = 1;</script></head>
<body><nav><a href="/">Accueil</a> <a href="#top">Haut</a></nav>
<h1>Créer un formulaire</h1><p>Un formulaire   regroupe des <b>champs</b>
 et des pages.</p><embed src="x.swf"><p>Après l'objet embarqué.</p>
<ul><li>Texte</li><li>Date <a href="https://example.org/dates">voir les dates</a></li></ul>
<table><tr><th>Champ</th><th>Type</th></tr><tr><td>Nom</td><td>texte</td></tr></table>
<svg><title>logo</title><path d="M0"/></svg><noscript>Activez JavaScript</noscript>
<pre>ligne 1
  ligne 2</pre><img alt="Capture de l'éditeur" src="e.png"><select><option>Choix caché</option></select>
<p>Fin &amp; suite</p></body></html>`;

test('a page comes back as its text: headings, paragraphs, lists, cells, no script, style, svg or select', { skip: !python }, () => {
  const [title, text] = py('print(json.dumps(r.html_to_text(sys.argv[1], "https://docs.example.com/a/b.html")))', [PAGE]);
  assert.equal(title, 'Guide des formulaires');
  assert.equal(text, [
    'Accueil Haut',
    '# Créer un formulaire',
    'Un formulaire regroupe des champs et des pages.',
    "Après l'objet embarqué.",
    '- Texte',
    '- Date voir les dates',
    'Champ | Type',
    'Nom | texte',
    'ligne 1\n  ligne 2',
    "Capture de l'éditeur",
    'Fin & suite'
  ].join('\n'));
  assert.doesNotMatch(text, /secret|color|logo|Activez|Choix caché/);
  const [, linked] = py('print(json.dumps(r.html_to_text(sys.argv[1], "https://docs.example.com/a/b.html", True)))', [PAGE]);
  assert.match(linked, /^\[Accueil\]\(https:\/\/docs\.example\.com\/\) Haut$/m, 'a relative link resolved, an anchor left as text');
  assert.match(linked, /^- Date \[voir les dates\]\(https:\/\/example\.org\/dates\)$/m);
  // a menu of links and buttons with nothing between them (convertigo.com), list items and headings left empty
  const [, menu] = py('print(json.dumps(r.html_to_text(sys.argv[1], "https://www.example.com/")))',
    ['<div><a href="/p">Platform</a><a href="/i">Industries</a><button>Menu</button></div><ul><li><a href="#"><svg></svg></a></li><li>Item</li></ul><h2> </h2>']);
  assert.equal(menu, 'Platform Industries Menu\n- Item');
});

test('a long page comes in parts of at most 12,000 characters, each starting where the last one stopped', { skip: !python }, () => {
  const parts = py(`
text = "\\n".join("Ligne %05d " % i + "é" * (i % 70) for i in range(3000))
out, offset = [], 0
while offset is not None:
    page = r.render("https://example.com/long", "Long", "text/html", text, offset, r.MAX_CHARS, False)
    body = page.split("\\n\\n", 1)[1]
    import re
    more = re.search(r"\\n\\n\\[(\\d+) more characters: run it again with --offset (\\d+)\\]$", body)
    part = body[:more.start()] if more else body
    out.append({"len": len(page), "part": part, "offset": offset, "head": page.split("\\n\\n", 1)[0]})
    offset = int(more.group(2)) if more else None
print(json.dumps({"parts": out, "text": text}))
`);
  assert.ok(parts.parts.length > 10);
  for (const part of parts.parts) {
    assert.ok(part.len <= 12000, 'a call prints ' + part.len + ' characters');
    assert.match(part.head, /^URL: https:\/\/example\.com\/long\nTitle: Long\nContent: text\/html, characters \d+-\d+ of \d+$/);
  }
  assert.equal(parts.parts.map(p => p.part).join('\n'), parts.text, 'the parts, joined at the line they were cut on, are the page');
  assert.ok(parts.parts.slice(0, -1).every(p => !p.part.endsWith('\n')), 'parts end on a whole line');
});

test('only public http(s) addresses are read: loopback, private, link-local and other schemes are refused', { skip: !python }, () => {
  const verdicts = py(`
out = {}
for url in sys.argv[1:]:
    try:
        r.check_public(url); out[url] = "ok"
    except r.ReadError as error:
        out[url] = str(error)
print(json.dumps(out))
`, ['http://127.0.0.1:8080/convertigo/', 'http://localhost/', 'http://10.1.2.3/', 'http://192.168.1.10/', 'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'ftp://example.com/file', 'file:///etc/passwd', 'https://1.1.1.1/', 'http://1.1.1.1:99999/']);
  for (const url of ['http://127.0.0.1:8080/convertigo/', 'http://localhost/', 'http://10.1.2.3/', 'http://192.168.1.10/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/']) {
    assert.match(verdicts[url], /is not a public address .*only public pages are read/, url);
  }
  assert.match(verdicts['ftp://example.com/file'], /only http and https addresses are read/);
  assert.match(verdicts['file:///etc/passwd'], /only http and https addresses are read/);
  assert.equal(verdicts['https://1.1.1.1/'], 'ok');
  assert.match(verdicts['http://1.1.1.1:99999/'], /not a valid URL/);

  const cli = spawnSync(python, ['-I', reader, 'http://127.0.0.1:9/'], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout.trim(), 'Cannot read the page: 127.0.0.1 is not a public address (127.0.0.1): only public pages are read');
});

// The fetch path against a local server: the address check is replaced by one that only refuses 10.9.9.9.
const SERVER = String.raw`
import gzip, http.server, threading
def refuse_private(url):
    if "10.9.9.9" in url:
        raise r.ReadError("10.9.9.9 is not a public address (10.9.9.9): only public pages are read")
    return url
r.check_public = refuse_private
page = ("<html><head><title>Caf\u00e9</title></head><body><h2>Menu</h2><p>Cr\u00e8me br\u00fbl\u00e9e</p>" + "<p>%s</p>" * 400 % tuple("para %d" % i for i in range(400)) + "</body></html>").encode("iso-8859-1")
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if self.path == "/moved":
            self.send_response(302); self.send_header("Location", "/page"); self.end_headers(); return
        if self.path == "/away":
            self.send_response(302); self.send_header("Location", "http://10.9.9.9/admin"); self.end_headers(); return
        if self.path == "/logo.png":
            self.send_response(200); self.send_header("Content-Type", "image/png"); self.end_headers(); self.wfile.write(b"\x89PNG...."); return
        if self.path == "/missing":
            self.send_response(404); self.send_header("Content-Type", "text/html"); self.end_headers(); self.wfile.write(b"<p>no</p>"); return
        if self.path == "/data.json":
            body = b'{"name": "C8Oforms", "pages": 3}'
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(body); return
        body = gzip.compress(page)
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=iso-8859-1")
        self.send_header("Content-Encoding", "gzip")
        self.end_headers()
        self.wfile.write(body)
server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = "http://127.0.0.1:%d" % server.server_address[1]
out = {}
for name, call in [
    ("page", lambda: r.read(base + "/moved", max_chars=2000)),
    ("next", lambda: r.read(base + "/moved", offset=1900, max_chars=2000)),
    ("json", lambda: r.read(base + "/data.json")),
]:
    out[name] = call()
for name, url in [("away", "/away"), ("png", "/logo.png"), ("missing", "/missing"), ("past", "/page")]:
    try:
        r.read(base + url, offset=10 ** 6) if name == "past" else r.read(base + url)
        out[name] = "read"
    except r.ReadError as error:
        out[name] = str(error)
out["base"] = base
print(json.dumps(out))
server.shutdown()
`;

test('a page is fetched through redirects, unzipped, decoded from its charset, and refused when it is not text or leads to a private address', { skip: !python }, () => {
  const out = py(SERVER);
  const base = out.base;
  assert.match(out.page, new RegExp('^URL: ' + base.replace(/\./g, '\\.') + '/page\nTitle: Café\nContent: text/html, characters 0-\\d+ of \\d+\n\n## Menu\nCrème brûlée\npara 0\n'));
  assert.ok(out.page.length <= 2000);
  assert.match(out.page, /\n\n\[\d+ more characters: run it again with --offset \d+\]$/);
  assert.match(out.next, /Content: text\/html, characters 1900-\d+ of \d+\n\n/);
  assert.match(out.json, /Content: application\/json, characters 0-32 of 32\n\n\{"name": "C8Oforms", "pages": 3\}$/);
  assert.equal(out.away, '10.9.9.9 is not a public address (10.9.9.9): only public pages are read', 'a redirect to a private address');
  assert.match(out.png, /\/logo\.png is image\/png \(8 bytes\), not a text page: it is not read here/);
  assert.match(out.missing, /^HTTP 404 Not Found for /);
  assert.match(out.past, /^--offset 1000000 is past the end of the page \(\d+ characters\)$/);
});

// The engine of the session: agents.tool_policy gives `policy`, Landlock confines, the Bridge's sandbox/python is `folder`.
class FakeFile {
  constructor(parent, child) { this.p = child === undefined ? String(parent.p || parent) : path.join(String(parent.p || parent), String(child)); }
  getCanonicalPath() { return path.resolve(this.p); }
  isFile() { return fs.existsSync(this.p) && fs.statSync(this.p).isFile(); }
}
function withEngine(policy, run, extra = {}) {
  const fakes = {
    File: FakeFile,
    confinedPythonPath: () => extra.folder === undefined ? moduleDir : extra.folder,
    serverUsesUserGatewayKeys: () => extra.userKeys === true,
    agentSandbox: () => ({ describe: () => JSON.stringify({ policy, effective: policy, landlockAbi: 1, helper: '/usr/local/bin/c8o-agent-sandbox' }) })
  };
  const saved = {};
  for (const [name, value] of Object.entries(fakes)) { saved[name] = global[name]; global[name] = value; }
  try { return run(); } finally { for (const [name, value] of Object.entries(saved)) global[name] = value; }
}

test('the No Code instructions name the reader under sandboxed-shell only, for Vibe, with the path of the Bridge\'s own copy', () => {
  const rule = withEngine('sandboxed-shell', () => noCodeWebReadRule('vibe', noCode));
  assert.equal(rule, "To read a public web page (documentation, an article, a public data file), run `python3 '" + reader +
    "' '<address>'` in your shell: it prints the page as text, at most 12,000 characters a call. When it says more remains, run it again with the --offset it gives; add --links to see where the links go. You have no web search: when you need a page whose address you do not know, ask the user for it.");
  const instructions = withEngine('sandboxed-shell', () => agentSkillInstructions('vibe', 'nocode', noCode));
  assert.ok(instructions.split('\n').includes(rule), instructions);
  assert.match(instructions, /Pass reveal:true only[^\n]*\nTo read a public web page[^\n]*\nReply in the user's language/);

  for (const policy of ['mcp-only', 'files', 'full']) {
    assert.equal(withEngine(policy, () => noCodeWebReadRule('vibe', noCode)), '', policy);
    assert.doesNotMatch(withEngine(policy, () => agentSkillInstructions('vibe', 'nocode', noCode)), /web page|c8o_web_read/, policy);
  }
  assert.equal(withEngine('sandboxed-shell', () => noCodeWebReadRule('vibe', noCode), { userKeys: true }), '', 'a server with per-user keys gives files');
  assert.equal(withEngine('sandboxed-shell', () => noCodeWebReadRule('codex', noCode)), '', 'Codex does not apply the policy');
  assert.equal(withEngine('sandboxed-shell', () => noCodeWebReadRule('vibe', { userId: 'studio' })), '', 'the Studio session');
  assert.equal(withEngine('sandboxed-shell', () => noCodeWebReadRule('vibe', noCode), { folder: '' }), '', 'no confined Python path');
  assert.equal(withEngine('sandboxed-shell', () => noCodeWebReadRule('vibe', noCode), { folder: os.tmpdir() }), '', 'a Bridge without the reader');
  // a home written outside a session, and the other profiles, as before
  assert.doesNotMatch(withEngine('sandboxed-shell', () => agentSkillInstructions('vibe', 'nocode')), /web page/);
  assert.doesNotMatch(withEngine('sandboxed-shell', () => agentSkillInstructions('vibe', 'generalist', noCode)), /c8o_web_read/);
  assert.doesNotMatch(agentSkillInstructions('vibe', 'nocode'), /\n\n/, 'no empty line left by an absent rule');
});

test('the No Code home writes that instruction into its AGENTS.md at each setup, and resident sessions restart on policy v8', () => {
  const source = fs.readFileSync(path.join(root, 'js/agent_bridge_common.js'), 'utf8');
  assert.match(source, /writeTextFile\(new File\(homeDir, "AGENTS\.md"\), agentSkillInstructions\(provider, profile, options\)\);/);
  assert.match(source, /var VIBE_NOCODE_TOOL_POLICY_REVISION = "v8";/);
  assert.equal(withEngine('sandboxed-shell', () => vibeToolPolicy(noCode)), 'nocode-sandboxed-shell-landlock-v8');
});
