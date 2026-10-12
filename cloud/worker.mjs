import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "../src/tools.mjs";
import { createHash, timingSafeEqual } from "node:crypto";
export { SolarStore } from "./storage.mjs";

const escape = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
const digest = (s) => createHash("sha256").update(s).digest();
export function ownerLogin(env, username, password) {
  if (!env.FELICITY_USER || !env.FELICITY_PASS) return false;
  return (
    timingSafeEqual(
      digest(String(username).trim().toLowerCase()),
      digest(env.FELICITY_USER.trim().toLowerCase()),
    ) && timingSafeEqual(digest(String(password)), digest(env.FELICITY_PASS))
  );
}
const json = (d, status = 200, headers = {}) =>
  Response.json(d, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
const store = (env) => env.SOLAR_STORE.get(env.SOLAR_STORE.idFromName("owner"));
function internal(env, path, body) {
  return store(env).fetch(
    new Request("https://solar.internal" + path, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    }),
  );
}
async function readInternal(env, path, body) {
  const r = await internal(env, path, body),
    d = await r.json();
  if (!r.ok) throw new Error(d.error || "Cloud data is unavailable.");
  return d;
}
function clientProxy(env) {
  const c = {
    timeZone: "Africa/Lagos",
    stamp: () =>
      new Date().toLocaleString("sv-SE", { timeZone: "Africa/Lagos" }),
  };
  for (const method of [
    "plants",
    "plant",
    "devices",
    "device",
    "snapshot",
    "chart",
    "request",
  ])
    c[method] = (...args) => readInternal(env, "/rpc", { method, args });
  return c;
}
const owner = (env) =>
  String(env.FELICITY_USER || "")
    .trim()
    .toLowerCase();
const cookieName = "__Host-felicity-session";
const cookie = (req, name) =>
  req.headers
    .get("Cookie")
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(name + "="))
    ?.slice(name.length + 1);
export function sameOrigin(req) {
  return req.headers.get("Origin") === new URL(req.url).origin;
}
async function hasSession(req, env) {
  const token = cookie(req, cookieName);
  if (!token) return false;
  return (
    (await env.OAUTH_KV.get("session:" + digest(token).toString("hex"))) ==
    owner(env)
  );
}
async function issueSession(env) {
  const token = crypto.randomUUID() + crypto.randomUUID();
  await env.OAUTH_KV.put(
    "session:" + digest(token).toString("hex"),
    owner(env),
    { expirationTtl: 30 * 86400 },
  );
  return `${cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 86400}`;
}
async function limitLogin(req, env) {
  const raw = req.headers.get("CF-Connecting-IP") || "local";
  return (
    await readInternal(env, "/limit", { key: digest(raw).toString("hex") })
  ).allowed;
}
function safeHtml(body, headers = {}, validatedRedirect) {
  // Browsers also apply form-action to the OAuth POST's redirect. Only allow
  // the callback that the provider validated against this client's metadata.
  const callback = validatedRedirect ? new URL(validatedRedirect) : null;
  const callbackSource = callback
    ? ["https:", "http:"].includes(callback.protocol)
      ? callback.origin
      : callback.protocol
    : "";
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "text/html; charset=utf-8");
  responseHeaders.set("Cache-Control", "no-store");
  responseHeaders.set(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${callbackSource ? " " + callbackSource : ""}; frame-ancestors 'none'; base-uri 'none'`,
  );
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  responseHeaders.set("Referrer-Policy", "no-referrer");
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Felicity Solar</title><style>body{font:16px system-ui;background:#f4f6ef;color:#223329;margin:40px auto;padding:24px;max-width:540px}input,button{font:inherit;padding:12px;margin:8px 0}input:not([type=checkbox]){display:block;width:90%}button{background:#23563c;color:white;border:0;border-radius:8px}a{color:#23563c}small{display:block;color:#576656}</style>${body}</html>`,
    { headers: responseHeaders },
  );
}
function loginFields() {
  return '<label>Email<input name="username" type="email" autocomplete="username" required></label><label>Felicity Solar password<input name="password" type="password" autocomplete="current-password" required></label>';
}

async function authorize(req, env) {
  const oauth = env.OAUTH_PROVIDER;
  if (req.method === "GET") {
    const auth = await oauth.parseAuthRequest(req),
      details = await oauth.describeConsent(auth),
      consent = await oauth.beginConsent(auth),
      signedIn = await hasSession(req, env);
    const scopes = details.scope.length ? details.scope : ["solar:read"];
    const fields = scopes
      .filter((s) =>
        ["solar:read", "widget:read", "offline_access"].includes(s),
      )
      .map(
        (s) =>
          `<label><input type="checkbox" name="scope" value="${escape(s)}" checked> ${escape(s === "solar:read" ? "Read my plants, devices, measurements and history" : s === "widget:read" ? "Read widget summaries" : "Stay connected between visits")}</label><br>`,
      )
      .join("");
    const html = `<h1>Connect Felicity Solar</h1><p><strong>${escape(details.clientName)}</strong> is requesting access.</p><p>Return address: <strong>${escape(details.redirectHost)}</strong>.</p>${details.clientDomain ? `<p>Verified client domain: ${escape(details.clientDomain)}</p>` : "<p>The client name is self-registered, not a verified identity.</p>"}${details.redirectIsLoopback ? "<p>Continue only if you started connecting an app on your computer.</p>" : ""}<form method="post" action="/authorize"><input type="hidden" name="handle" value="${escape(consent.handle)}">${signedIn ? "" : loginFields()}<h2>Permissions</h2>${fields}<p>This service is private to the configured owner. It cannot change inverter settings.</p><button name="decision" value="approve">Allow read access</button> <button name="decision" value="deny" formnovalidate>Deny</button></form><small>Use your Felicity login only on your own deployed service.</small>`;
    return safeHtml(html, consent.headers, auth.redirectUri);
  }
  if (req.method !== "POST" || !sameOrigin(req))
    return json({ error: "Origin rejected" }, 403);
  if (!(await limitLogin(req, env)))
    return json({ error: "Try signing in again in a minute." }, 429);
  const form = await req.formData(),
    handle = String(form.get("handle") || "");
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(req, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  if (
    !(await hasSession(req, env)) &&
    !ownerLogin(env, form.get("username"), form.get("password"))
  )
    return safeHtml(
      "<h1>Sign-in failed</h1><p>Check your owner login and start the connection again.</p>",
      {},
    );
  const approved = await oauth.approveConsent(req, handle, {
    scope: form.getAll("scope").map(String),
  });
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request,
    userId: owner(env),
    metadata: { label: "Personal solar data" },
    scope: approved.request.scope,
    props: { userId: owner(env) },
  });
  approved.headers.append("Set-Cookie", await issueSession(env));
  if (req.headers.get("Accept")?.includes("text/html")) {
    // A normal link avoids applying the submitting form's CSP to a client's
    // subsequent callback redirects, while keeping the page script-free.
    return safeHtml(
      `<h1>Access approved</h1><p>Return to your app to finish connecting Felicity Solar.</p><p><a id="oauth-continue" href="${escape(redirectTo)}" rel="noreferrer noopener">Continue to your app</a></p>`,
      approved.headers,
    );
  }
  approved.headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers: approved.headers });
}

const apiHandler = {
  async fetch(req, env, ctx) {
    if (ctx.props?.userId !== owner(env))
      return json({ error: "Owner access required" }, 403);
    const u = new URL(req.url),
      scopes = ctx.auth?.scope || [];
    if (u.pathname === "/api/widget") {
      if (!scopes.some((s) => ["widget:read", "solar:read"].includes(s)))
        return json({ error: "Widget read permission required" }, 403);
      return internal(env, "/widget" + u.search);
    }
    if (u.pathname !== "/mcp") return json({ error: "Not found" }, 404);
    if (!scopes.includes("solar:read"))
      return json({ error: "Solar read permission required" }, 403);
    const c = clientProxy(env),
      server = createServer(c, {
        get_grid_patterns: (a) =>
          readInternal(
            env,
            "/patterns?" +
              new URLSearchParams({
                plant: a.plantId,
                start: a.startDate,
                end: a.endDate,
                samples: String(a.includeSamples),
              }),
          ),
        get_daily_analysis: (a) =>
          readInternal(
            env,
            "/day?" +
              new URLSearchParams({
                plant: a.plantId,
                date: a.date || c.stamp().slice(0, 10),
                samples: String(a.includeSamples),
              }),
          ),
      });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: 1024 * 1024,
    });
    await server.connect(transport);
    const response = await transport.handleRequest(req);
    ctx.waitUntil(Promise.all([transport.close(), server.close()]));
    return response;
  },
};

const defaultHandler = {
  async fetch(req, env, ctx) {
    const u = new URL(req.url);
    if (u.pathname === "/health")
      return json({
        service: "Felicity Solar",
        ready: Boolean(env.FELICITY_USER && env.FELICITY_PASS),
        cloud: true,
      });
    if (u.pathname === "/authorize") return authorize(req, env);
    if (u.pathname === "/api/login" && req.method === "POST") {
      if (!sameOrigin(req)) return json({ error: "Origin rejected" }, 403);
      if (!(await limitLogin(req, env)))
        return json({ error: "Try signing in again in a minute." }, 429);
      const b = await req.json();
      if (!ownerLogin(env, b.username, b.password))
        return json({ error: "Owner sign-in required" }, 401);
      ctx.waitUntil(internal(env, "/collect", {}));
      return json({ connected: true, cloud: true }, 200, {
        "Set-Cookie": await issueSession(env),
      });
    }
    if (u.pathname === "/api/status" && !(await hasSession(req, env)))
      return json({
        connected: false,
        cloud: true,
        plants: [],
        sync: {
          running: false,
          completed: 0,
          total: 0,
          error: null,
          lastSync: null,
        },
      });
    if (u.pathname.startsWith("/api/")) {
      if (!(await hasSession(req, env)))
        return json({ error: "Sign in to your cloud dashboard" }, 401);
      if (req.method !== "GET" && !sameOrigin(req))
        return json({ error: "Origin rejected" }, 403);
      if (u.pathname === "/api/logout" && req.method === "POST") {
        const t = cookie(req, cookieName);
        if (t)
          await env.OAUTH_KV.delete("session:" + digest(t).toString("hex"));
        return json({ loggedOut: true }, 200, {
          "Set-Cookie": `${cookieName}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
        });
      }
      if (u.pathname === "/api/export") {
        const d = await readInternal(env, "/dashboard" + u.search);
        return new Response(
          "date,time,pv_w,grid_w,load_w,battery_percent,grid_voltage_v,grid_present\n" +
            d.days
              .flatMap((day) =>
                day.samples.map((s) =>
                  [
                    s.date,
                    s.time,
                    s.pv,
                    s.grid,
                    s.load,
                    s.soc,
                    s.voltage,
                    s.gridOn,
                  ].join(","),
                ),
              )
              .join("\n"),
          {
            headers: {
              "Content-Type": "text/csv",
              "Content-Disposition":
                'attachment; filename="felicity-solar.csv"',
              "Cache-Control": "no-store",
            },
          },
        );
      }
      const paths = {
        "/api/status": "/status",
        "/api/dashboard": "/dashboard",
        "/api/widget": "/widget",
        "/api/sync": "/sync",
        "/api/import": "/import",
      };
      if (paths[u.pathname]) {
        if (Number(req.headers.get("Content-Length") || 0) > 4 * 1024 * 1024)
          return json({ error: "Request too large" }, 413);
        return internal(
          env,
          paths[u.pathname] + u.search,
          req.method === "POST" ? await req.json() : undefined,
        );
      }
      return json({ error: "Not found" }, 404);
    }
    return env.ASSETS.fetch(req);
  },
};

export default {
  async fetch(req, env, ctx) {
    const origin = env.PUBLIC_ORIGIN || new URL(req.url).origin;
    if (env.PUBLIC_ORIGIN && new URL(req.url).origin !== origin)
      return json({ error: "Host rejected" }, 403);
    const provider = new OAuthProvider({
      apiRoute: ["/mcp", "/api/widget"],
      apiHandler,
      defaultHandler,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/register",
      scopesSupported: ["solar:read", "widget:read", "offline_access"],
      requiredScopes: ["solar:read"],
      resourceMetadata: {
        resource: origin,
        authorization_servers: [origin],
        resource_name: "Felicity Solar",
      },
      accessTokenTTL: 3600,
      refreshTokenTTL: 30 * 86400,
      refreshTokenIdleTTL: 30 * 86400,
      clientIdMetadataDocumentEnabled: true,
      allowPrivateUseRedirectUris: true,
    });
    try {
      return await provider.fetch(req, env, ctx);
    } catch {
      return json(
        { error: "Connection could not be completed. Please restart sign-in." },
        400,
      );
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(internal(env, "/collect", {}));
  },
};
