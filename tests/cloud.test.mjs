import test from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const origin = "https://solar.example.test";
const user = "owner@example.test",
  password = "synthetic-fixture-password";
const stamp = () =>
  new Date().toLocaleString("sv-SE", { timeZone: "Africa/Lagos" });
async function fakeVendor(req) {
  const path = new URL(req.url).pathname;
  let data;
  if (path === "/userlogin") data = { token: "synthetic-vendor-token" };
  else if (path === "/plant/list_condition_plant")
    data = {
      dataList: [{ id: "test-plant", plantName: "Example house" }],
      total: 1,
    };
  else if (path === "/device/list_device_all_type")
    data = {
      dataList: [
        {
          deviceSn: "fixture-inverter",
          deviceType: "OG",
          plantId: "test-plant",
        },
      ],
      total: 1,
    };
  else if (path === "/plant/plantDetails")
    data = { id: "test-plant", timeZone: "UTC+01:00" };
  else if (path === "/device/get_device_snapshot")
    data = {
      dataTimeStr: stamp(),
      acRInVolt: "230",
      emsSoc: "60",
      pvTotalPower: "500",
      acTotalOutActPower: "200",
      acTtlInpower: "100",
      reportFreq: 300,
    };
  else if (
    [
      "/storageRealtimeData/list_storageRealtimeData_new",
      "/device/device_warring_list",
      "/device/warring/group",
    ].includes(path)
  )
    data = { dataList: [], total: 0 };
  else if (path === "/storageRealtimeData/display")
    data = [{ field: "acRInVolt", unit: "V" }];
  else if (path === "/device/get_energy_flow2") data = { gridPower: 100 };
  else if (path === "/storageRealtimeData/chart_storageRealtimeData_mate") {
    const b = await req.json();
    const series =
      b.chartScopeType === 3
        ? [{ field: "emsSoc", data: ["60", "60"] }]
        : b.field?.includes("acRInVolt")
          ? [{ field: "acRInVolt", data: ["230", "230"] }]
          : [{ field: "pvElectricity", data: ["500", "500"] }];
    data = {
      dataTime: ["00:00", "00:05"],
      storageMateDTOS: series,
      pvOutputKwh: 1,
    };
  } else return Response.json({ code: 404 });
  return Response.json({ code: 200, data });
}
test(
  "Workers OAuth, private data, cloud collector, native scopes and MCP protocol",
  { timeout: 120000 },
  async () => {
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        name: "main",
        modules: [
          { type: "ESModule", path: "local/cloud-build/worker.js" },
          ...readdirSync("local/cloud-build")
            .filter((f) => f.endsWith(".pem"))
            .map((f) => ({ type: "Text", path: "local/cloud-build/" + f })),
        ],
        modulesRoot: "local/cloud-build",
        compatibilityDate: "2026-10-12",
        compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
        bindings: {
          FELICITY_USER: user,
          FELICITY_PASS: password,
          PUBLIC_ORIGIN: origin,
        },
        kvNamespaces: ["OAUTH_KV"],
        durableObjects: {
          SOLAR_STORE: { className: "SolarStore", useSQLite: true },
        },
        outboundService: fakeVendor,
        serviceBindings: {
          ASSETS: async () => new Response("Static dashboard"),
        },
      }),
    );
    const call = (path, options = {}) =>
      mf.dispatchFetch(origin + path, { redirect: "manual", ...options });
    try {
      const health = await call("/health");
      assert.equal(health.status, 200, await health.text());
      const anonymous = await (await call("/api/status")).json();
      assert.equal(anonymous.connected, false);
      assert.deepEqual(anonymous.plants, []);
      assert.equal((await call("/api/dashboard")).status, 401);
      assert.equal(
        (await call("/api/import", { method: "POST", body: "{}" })).status,
        401,
      );
      assert.equal((await call("/mcp")).status, 401);
      const loginBody = JSON.stringify({ username: user, password });
      assert.equal(
        (
          await call("/api/login", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: "https://evil.example",
            },
            body: loginBody,
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await call("/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: origin },
            body: JSON.stringify({ username: user, password: "wrong" }),
          })
        ).status,
        401,
      );
      const signedIn = await call("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: loginBody,
      });
      assert.equal(signedIn.status, 200);
      const ownerCookie = signedIn.headers.get("Set-Cookie").split(";")[0];
      const bindings = await mf.getBindings();
      await bindings.SOLAR_STORE.get(
        bindings.SOLAR_STORE.idFromName("owner"),
      ).fetch("https://solar.internal/collect", { method: "POST" });
      const dashboard = await (
        await call("/api/dashboard", { headers: { Cookie: ownerCookie } })
      ).json();
      assert.equal(dashboard.plant.name, "Example house");
      assert.equal(dashboard.current.gridOn, true);
      async function tokenFor(
        scopes,
        redirect = "https://client.example.test/callback",
      ) {
        const reg = await call("/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_name: "Fixture client",
            redirect_uris: [redirect],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          }),
        });
        assert.equal(reg.status, 201);
        const { client_id } = await reg.json(),
          verifier = "fixture-verifier-abcdefghijklmnopqrstuvwxyz-1234567890",
          challenge = createHash("sha256").update(verifier).digest("base64url");
        const params = new URLSearchParams({
          response_type: "code",
          client_id,
          redirect_uri: redirect,
          scope: scopes.join(" "),
          state: "fixture-state",
          code_challenge: challenge,
          code_challenge_method: "S256",
          resource: origin,
        });
        const consent = await call("/authorize?" + params, {
          headers: { Cookie: ownerCookie },
        });
        assert.equal(consent.status, 200);
        const html = await consent.text();
        assert.ok(html.includes("Allow read access"));
        assert.ok(!html.includes(password));
        const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
        assert.ok(handle);
        const consentCookie = consent.headers.get("Set-Cookie").split(";")[0];
        const form = new URLSearchParams({ handle, decision: "approve" });
        for (const scope of scopes) form.append("scope", scope);
        const allowed = await call("/authorize", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Origin: origin,
            Cookie: ownerCookie + "; " + consentCookie,
          },
          body: form.toString(),
        });
        assert.equal(allowed.status, 302);
        const callback = new URL(allowed.headers.get("Location"));
        assert.equal(callback.searchParams.get("state"), "fixture-state");
        const exchange = new URLSearchParams({
          grant_type: "authorization_code",
          client_id,
          code: callback.searchParams.get("code"),
          redirect_uri: redirect,
          code_verifier: verifier,
          resource: origin,
        });
        const tokens = await call("/oauth/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: exchange.toString(),
        });
        assert.equal(tokens.status, 200);
        return {
          ...(await tokens.json()),
          client_id,
          exchange: exchange.toString(),
        };
      }
      const tokens = await tokenFor(["solar:read", "offline_access"]);
      assert.ok(tokens.refresh_token);
      const c = new Client({ name: "cloud-protocol-test", version: "1" });
      const transport = new StreamableHTTPClientTransport(
        new URL(origin + "/mcp"),
        {
          requestInit: {
            headers: { Authorization: "Bearer " + tokens.access_token },
          },
          fetch: async (input, init) =>
            mf.dispatchFetch(
              typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.href
                  : input.url,
              init,
            ),
        },
      );
      try {
        await c.connect(transport);
        assert.equal((await c.listTools()).tools.length, 14);
        const r = await c.callTool({
          name: "get_grid_status",
          arguments: { plantId: "test-plant" },
        });
        assert.equal(r.isError, undefined);
        assert.equal(JSON.parse(r.content[0].text).gridOn, true);
        const plant = { plantId: "test-plant" },
          device = { deviceSn: "fixture-inverter" };
        for (const [name, args] of Object.entries({
          list_plants: {},
          get_plant: plant,
          list_devices: plant,
          get_device_snapshot: device,
          get_all_snapshots: plant,
          get_energy_flow: plant,
          get_chart: plant,
          get_history_rows: device,
          get_available_fields: device,
          get_device_alarms: device,
          get_alarm_summary: plant,
          get_daily_analysis: plant,
          get_grid_patterns: {
            ...plant,
            startDate: stamp().slice(0, 10),
            endDate: stamp().slice(0, 10),
          },
        })) {
          const result = await c.callTool({ name, arguments: args });
          assert.equal(
            result.isError,
            undefined,
            name + ": " + result.content?.[0]?.text,
          );
        }
      } finally {
        await c.close();
      }
      assert.equal(
        (
          await call("/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: tokens.exchange,
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await call("/mcp", {
            headers: { Authorization: "Bearer " + tokens.access_token },
          })
        ).status,
        401,
      );
      const widget = await tokenFor(
        ["widget:read", "offline_access"],
        "com.example.felicitysolar://oauth/callback",
      );
      const w = await call("/api/widget", {
        headers: { Authorization: "Bearer " + widget.access_token },
      });
      assert.equal(w.status, 200);
      assert.equal((await w.json()).gridOn, true);
      assert.equal(
        (
          await call("/mcp", {
            method: "POST",
            headers: {
              Authorization: "Bearer " + widget.access_token,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/list",
            }),
          })
        ).status,
        403,
      );
      const refresh = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: widget.refresh_token,
        client_id: widget.client_id,
        resource: origin,
      });
      assert.equal(
        (
          await call("/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: refresh.toString(),
          })
        ).status,
        200,
      );
    } finally {
      await mf.dispose();
    }
  },
);
