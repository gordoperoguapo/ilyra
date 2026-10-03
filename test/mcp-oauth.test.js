// Browser sign-in (OAuth) for a connector, against a fake service that behaves like Higgsfield-style MCP servers:
// 401 + discovery, dynamic client registration, authorize redirect, token exchange.
const assert = require('assert');
const http = require('node:http'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createManager } = require('../electron/mcp');

let base = '';
const registered = []; let tokenCalls = 0;
const json = (res, code, body, h = {}) => { res.writeHead(code, Object.assign({ 'content-type': 'application/json' }, h)); res.end(JSON.stringify(body)); };
const readBody = async (req) => { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c).toString(); };
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, base);
  if (u.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(res, 200, { resource: base + '/mcp', authorization_servers: [base] });
  if (u.pathname.startsWith('/.well-known/oauth-authorization-server')) return json(res, 200, { issuer: base, authorization_endpoint: base + '/authorize', token_endpoint: base + '/token', registration_endpoint: base + '/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
  if (u.pathname === '/register') { const b = JSON.parse(await readBody(req)); registered.push(b); return json(res, 201, Object.assign({ client_id: 'ilyra-client' }, b)); }
  if (u.pathname === '/authorize') { const back = new URL(u.searchParams.get('redirect_uri')); back.searchParams.set('code', 'the-code'); back.searchParams.set('state', u.searchParams.get('state')); res.writeHead(302, { location: back.toString() }); return res.end(); }
  if (u.pathname === '/token') { tokenCalls++; const p = new URLSearchParams(await readBody(req)); assert.ok(p.get('code_verifier')); return json(res, 200, { access_token: 'tok-' + tokenCalls, token_type: 'Bearer', refresh_token: 'r', expires_in: 3600 }); }
  if (u.pathname === '/mcp') {
    if (!/^Bearer tok-/.test(req.headers.authorization || '')) return json(res, 401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` });
    const raw = await readBody(req);
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); const s = new McpServer({ name: 'fake', version: '1' });
    s.registerTool('ping', { description: 'p', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
    await s.connect(t); res.on('close', () => { t.close(); s.close(); });
    return t.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
  }
  res.writeHead(404); res.end();
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const vault = {};
  const opened = [];
  const mgr = createManager({
    file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-')), 'c.json'),
    secrets: { get: (k) => vault[k], set: (k, v) => { vault[k] = v; }, remove: (k) => { delete vault[k]; } },
    // The "browser": follows the login page's redirect back to Ilyra's loopback address.
    openExternal: (url) => { opened.push(url); fetch(url).catch(() => {}); }
  });
  const added = await mgr.add({ name: 'Higgsfield', url: base + '/mcp' });
  assert.strictEqual(added.state.status, 'needs-auth', JSON.stringify(added.state));
  const after = await mgr.signIn(added.id);
  assert.strictEqual(after.status, 'connected', JSON.stringify(after));
  assert.strictEqual(opened.length, 1); assert.ok(/code_challenge=/.test(opened[0]), 'uses PKCE');
  assert.ok(/^http:\/\/localhost:\d+\/callback$/.test(registered[registered.length - 1].redirect_uris[0]), 'registers its own loopback address');
  assert.deepStrictEqual(after.tools, ['ping']);
  const defs = await mgr.prepare(); assert.strictEqual(defs[0].name, 'mcp_higgsfield_ping');
  const r = await mgr.call('mcp_higgsfield_ping', {}, { confirm: async () => true });
  assert.ok(/pong/.test(r.output));
  await mgr.closeAll(); server.close();
  console.log('mcp oauth tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
