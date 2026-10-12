#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { FelicityClient, redact } from "./client.mjs";
import { normalize, summarize, analyze } from "./analytics.mjs";
const client = new FelicityClient();
const id = z.string().min(1).max(100),
  date = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(
      (s) =>
        !Number.isNaN(Date.parse(s)) &&
        new Date(s).toISOString().slice(0, 10) === s,
      "Valid calendar date required",
    );
const page = z.number().int().min(1).max(10000).default(1),
  size = z.number().int().min(1).max(100).default(100);
const scope = { plantId: id.optional(), deviceSn: id.optional() };
const dateDefault = (c) => c.stamp().slice(0, 10);
async function select(c, a) {
  if (Boolean(a.plantId) === Boolean(a.deviceSn))
    throw new Error("Provide exactly one of plantId or deviceSn.");
  if (a.plantId) await c.plant(a.plantId);
  else await c.device(a.deviceSn);
}
function alarmFilters(a) {
  const leftDate = a.startDate
      ? Date.parse(a.startDate + "T00:00:00Z")
      : Date.now() - 30 * 86400000,
    rightDate = a.endDate ? Date.parse(a.endDate + "T23:59:59Z") : Date.now();
  if (leftDate > rightDate)
    throw new Error("Start date must precede end date.");
  return {
    pageNum: a.pageNum,
    pageSize: a.pageSize,
    status: "",
    warringType: "",
    faultcode: "",
    warringName: "",
    deviceAlias: "",
    leftDate,
    rightDate,
  };
}
export function createServer(c = client) {
  const s = new McpServer({ name: "felicity-solar-data", version: "0.1.0" });
  const tool = (name, description, inputSchema, fn) =>
    s.registerTool(
      name,
      {
        description,
        inputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (a) => {
        try {
          const data = redact(await fn(a));
          return { content: [{ type: "text", text: JSON.stringify(data) }] };
        } catch (e) {
          return {
            isError: true,
            content: [{ type: "text", text: e.message }],
          };
        }
      },
    );
  tool(
    "list_plants",
    "List every accessible solar plant, with vendor metadata. Automatically follows pagination.",
    {},
    () => c.plants(),
  );
  tool(
    "get_plant",
    "Plant details, timezone, capacity, devices, totals and telemetry capabilities.",
    { plantId: id },
    (a) => c.plant(a.plantId),
  );
  tool(
    "list_devices",
    "All accessible inverters, batteries, collectors and other device types. Automatically follows pagination.",
    { plantId: id.optional() },
    async (a) => {
      if (a.plantId) await c.plant(a.plantId);
      return c.devices(a.plantId);
    },
  );
  tool(
    "get_device_snapshot",
    "Complete raw device telemetry and metadata: PV channels, grid voltage, load, SOC/SOH, battery cells, temperatures, counters, firmware and reporting frequency when provided. dataTimeStr is device-local wall time; numeric dataTime may use a different encoding.",
    { deviceSn: id },
    (a) => c.snapshot(a.deviceSn),
  );
  tool(
    "get_all_snapshots",
    "Read latest available cloud telemetry for all devices in a plant or account. Per-device failures are explicit; fetchedAt is not measurement time.",
    { plantId: id.optional() },
    async (a) => {
      if (a.plantId) await c.plant(a.plantId);
      const d = await c.devices(a.plantId);
      const snapshots = [];
      for (const x of d.items) {
        try {
          snapshots.push(await c.snapshot(x.deviceSn));
        } catch (e) {
          snapshots.push({ deviceSn: x.deviceSn, error: e.message });
        }
      }
      return {
        fetchedAt: new Date().toISOString(),
        complete: d.complete,
        snapshots,
      };
    },
  );
  tool(
    "get_energy_flow",
    "Plant energy flow, grid/PV/battery/load readings, voltages and power routing. Does not enable remote controls or streaming.",
    { plantId: id },
    async (a) => {
      await c.plant(a.plantId);
      return c.request(
        "/device/get_energy_flow2?" +
          new URLSearchParams({
            plantId: a.plantId,
            deviceSn: "",
            pageNum: "1",
            pageSize: "9999",
          }),
        undefined,
        { method: "GET" },
      );
    },
  );
  tool(
    "get_chart",
    "Raw time-series with all vendor fields, names and units. Hour = intraday, month = daily for a month, year = monthly. Choose power, soc or energy. Query each date/month to retrieve all available history; empty data is not zero.",
    {
      ...scope,
      date: date.optional(),
      period: z.enum(["hour", "month", "year"]).default("hour"),
      kind: z.enum(["power", "soc", "energy"]).default("power"),
      fields: z.array(id).max(100).default([]),
    },
    async (a) => {
      await select(c, a);
      return c.chart({ ...a, date: a.date || dateDefault(c) });
    },
  );
  tool(
    "get_history_rows",
    "Complete raw pageable measurement rows for any device on a date. Follow dataList/total pagination until exhausted. pageSize <=100.",
    { deviceSn: id, date: date.optional(), pageNum: page, pageSize: size },
    async (a) => {
      const d = await c.device(a.deviceSn);
      return c.request("/storageRealtimeData/list_storageRealtimeData_new", {
        deviceSn: a.deviceSn,
        deviceType: d.deviceType,
        dateStr: (a.date || dateDefault(c)) + " 23:59:59",
        pageNum: a.pageNum,
        pageSize: a.pageSize,
      });
    },
  );
  tool(
    "get_available_fields",
    "Vendor field/display definitions, units and telemetry schema for any device. All available vendor fields are retained.",
    { deviceSn: id, date: date.optional() },
    async (a) => {
      const d = await c.device(a.deviceSn);
      return c.request("/storageRealtimeData/display", {
        deviceSn: a.deviceSn,
        deviceType: d.deviceType,
        dateStr: (a.date || dateDefault(c)) + " 23:59:59",
      });
    },
  );
  tool(
    "get_device_alarms",
    "Read pageable device alarm/fault history for a date range (defaults to last30 days). Does not acknowledge or clear faults.",
    {
      deviceSn: id,
      startDate: date.optional(),
      endDate: date.optional(),
      pageNum: page,
      pageSize: size,
    },
    async (a) => {
      const d = await c.device(a.deviceSn);
      return c.request("/device/device_warring_list", {
        deviceSn: a.deviceSn,
        deviceType: d.deviceType,
        plantId: d.plantId,
        ...alarmFilters(a),
      });
    },
  );
  tool(
    "get_alarm_summary",
    "Read grouped pageable alarms for an accessible plant and date range (defaults to last30 days).",
    {
      plantId: id,
      startDate: date.optional(),
      endDate: date.optional(),
      pageNum: page,
      pageSize: size,
    },
    async (a) => {
      await c.plant(a.plantId);
      return c.request("/device/warring/group", {
        plantId: a.plantId,
        deviceSn: "",
        ...alarmFilters(a),
      });
    },
  );
  tool(
    "get_grid_status",
    "Grid presence inferred from inverter AC input voltage (>=90V). Includes measurement age and actual reporting frequency. Older than 15 minutes or absent voltage is unknown, not OFF.",
    { plantId: id },
    async (a) => {
      const details = await c.plant(a.plantId),
        devices = (await c.devices(a.plantId)).items.filter(
          (d) => d.deviceType === "OG",
        );
      const readings = [];
      const offset = /^UTC([+-]\d{2}:\d{2})$/.exec(
        details.timeZone || details.timeZoneStr || "",
      )?.[1];
      for (const d of devices) {
        try {
          const { snapshot: x } = await c.snapshot(d.deviceSn);
          const tz =
            offset || /^UTC([+-]\d{2}:\d{2})$/.exec(x.timeZone || "")?.[1];
          const at =
            x.dataTimeStr && tz
              ? new Date(x.dataTimeStr.replace(" ", "T") + tz)
              : null;
          const ageSeconds =
            at && !Number.isNaN(+at) ? (Date.now() - at) / 1000 : null;
          const voltage =
            x.acRInVolt === null ||
            x.acRInVolt === undefined ||
            x.acRInVolt === ""
              ? null
              : Number(x.acRInVolt);
          const fresh =
            ageSeconds !== null && ageSeconds >= -60 && ageSeconds < 900;
          readings.push({
            deviceSn: d.deviceSn,
            voltage: Number.isFinite(voltage) ? voltage : null,
            gridOn: fresh && Number.isFinite(voltage) ? voltage >= 90 : null,
            observedLocal: x.dataTimeStr,
            timezone: tz || null,
            ageSeconds,
            reportSeconds: x.reportFreq,
          });
        } catch (e) {
          readings.push({
            deviceSn: d.deviceSn,
            gridOn: null,
            error: e.message,
          });
        }
      }
      return {
        plantId: a.plantId,
        fetchedAt: new Date().toISOString(),
        gridOn: readings.some((r) => r.gridOn === true)
          ? true
          : readings.length && readings.every((r) => r.gridOn === false)
            ? false
            : null,
        readings,
        notice:
          "Cloud readings reflect device uploads, not guaranteed real-time electrical status.",
      };
    },
  );
  tool(
    "get_daily_analysis",
    "Daily PV kWh, highest PV watts/time, duration >=90% of peak, lowest battery SOC, grid hours/known hours, outage duration and energy totals. Currently analysis uses Africa/Lagos timezone and 5-minute sampling; raw tools support other installations.",
    {
      plantId: id,
      date: date.optional(),
      includeSamples: z.boolean().default(false),
    },
    async (a) => {
      const day = await dayAnalysis(c, a.plantId, a.date || dateDefault(c));
      if (!a.includeSamples) delete day.samples;
      return day;
    },
  );
  tool(
    "get_grid_patterns",
    "Daily and weekly grid totals, weekday/hour probability map, cautious next likely window, best solar day and lowest battery. Queries up to31 days per call, accepts any historical range; unknown intervals stay unknown. Forecast is a historical probability, not a utility schedule. Analysis currently supports Africa/Lagos, 5-minute samples.",
    {
      plantId: id,
      startDate: date,
      endDate: date,
      includeSamples: z.boolean().default(false),
    },
    async (a) => {
      const n =
        Math.round(
          (Date.parse(a.endDate) - Date.parse(a.startDate)) / 86400000,
        ) + 1;
      if (n < 1 || n > 31)
        throw new Error(
          "Request an ordered range of 1–31 days; use adjacent ranges for longer history.",
        );
      const days = [];
      for (let i = 0; i < n; i++) {
        const d = new Date(Date.parse(a.startDate) + i * 86400000)
          .toISOString()
          .slice(0, 10);
        days.push(await dayAnalysis(c, a.plantId, d));
      }
      const result = analyze(days);
      if (!a.includeSamples) for (const d of result.days) delete d.samples;
      return {
        ...result,
        assumptions: {
          timezone: "Africa/Lagos",
          sampleMinutes: 5,
          gridThresholdVolts: 90,
          peakThreshold: 0.9,
        },
        warning:
          "Probabilities describe observed history. Missing reports and days before installation are unknown.",
      };
    },
  );
  return s;
}
async function dayAnalysis(c, plantId, date) {
  if (c.timeZone !== "Africa/Lagos")
    throw new Error(
      "Analysis currently supports Africa/Lagos. Use raw charts for other timezones.",
    );
  const power = await c.chart({ plantId, date }),
    soc = await c.chart({ plantId, date, kind: "soc" }),
    volts = [];
  for (const d of (await c.devices(plantId)).items.filter(
    (d) => d.deviceType === "OG",
  ))
    volts.push(
      await c.chart({
        deviceSn: d.deviceSn,
        date,
        fields: ["acRInVolt", "devTempMin"],
      }),
    );
  return summarize(date, normalize(date, power, soc, volts), power.pvOutputKwh);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--http")) {
    const port = Number(process.env.FELICITY_MCP_PORT || 4318);
    http
      .createServer(async (req, res) => {
        if (
          !["127.0.0.1:" + port, "localhost:" + port].includes(
            req.headers.host,
          ) ||
          req.headers.origin
        ) {
          res.writeHead(403);
          res.end();
          return;
        }
        if (req.url !== "/mcp" || req.method !== "POST") {
          res.writeHead(404);
          res.end();
          return;
        }
        const server = createServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        try {
          await server.connect(transport);
          await transport.handleRequest(req, res);
          res.on("close", () => {
            void transport.close();
            void server.close();
          });
        } catch {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        }
      })
      .listen(port, "127.0.0.1", () =>
        console.error("Felicity MCP listening on loopback port " + port),
      );
  } else await createServer().connect(new StdioServerTransport());
}
