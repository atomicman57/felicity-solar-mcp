import { DurableObject } from "cloudflare:workers";
import { FelicityClient } from "../src/client.mjs";
import {
  normalize,
  summarize,
  analyze,
  normalizeLiveSnapshots,
} from "../src/analytics.mjs";
import publicKey from "../src/public-key.pem";

const today = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
const dates = (n, end = today()) =>
  Array.from({ length: n }, (_, i) =>
    new Date(Date.parse(end + "T12:00:00Z") - (n - i - 1) * 86400000)
      .toISOString()
      .slice(0, 10),
  );
const json = (d, status = 200) =>
  Response.json(d, { status, headers: { "Cache-Control": "no-store" } });
export async function pack(d) {
  return new Uint8Array(
    await new Response(
      new Blob([JSON.stringify(d)])
        .stream()
        .pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );
}
export async function unpack(d) {
  return JSON.parse(
    await new Response(
      new Blob([d]).stream().pipeThrough(new DecompressionStream("gzip")),
    ).text(),
  );
}

// This object is reachable only through the Worker's private binding, never a public URL.
export class SolarStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS daily (plant TEXT, date TEXT, data BLOB NOT NULL, PRIMARY KEY(plant,date))",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS telemetry (device TEXT, observed TEXT, fetched TEXT, data BLOB NOT NULL, PRIMARY KEY(device,observed))",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS pending (plant TEXT, date TEXT, priority INTEGER, attempts INTEGER DEFAULT 0, PRIMARY KEY(plant,date))",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS login_limits (key TEXT PRIMARY KEY, window INTEGER, count INTEGER)",
    );
    this.client = new FelicityClient({
      user: env.FELICITY_USER,
      pass: env.FELICITY_PASS,
      publicKey,
      timeZone: "Africa/Lagos",
    });
    this.analysisCache = new Map();
  }
  get(k, fallback = null) {
    const r = this.sql
      .exec("SELECT value FROM state WHERE key=?", k)
      .toArray()[0];
    return r ? JSON.parse(r.value) : fallback;
  }
  put(k, v) {
    this.sql.exec(
      "INSERT OR REPLACE INTO state VALUES(?,?)",
      k,
      JSON.stringify(v),
    );
  }
  async saveDay(plant, day) {
    this.sql.exec(
      "INSERT OR REPLACE INTO daily VALUES(?,?,?)",
      String(plant),
      day.date,
      await pack(day),
    );
    this.put("dailyRevision", Date.now());
  }
  plants() {
    return this.get("plants", { items: [], complete: true });
  }
  devices() {
    return this.get("devices", { items: [], complete: true });
  }
  enqueue(n = 30) {
    for (const p of this.plants().items)
      for (const d of dates(n)) {
        const exists = this.sql
          .exec("SELECT 1 FROM daily WHERE plant=? AND date=?", String(p.id), d)
          .toArray().length;
        if (!exists || d === today())
          this.sql.exec(
            "INSERT OR IGNORE INTO pending(plant,date,priority) VALUES(?,?,?)",
            String(p.id),
            d,
            d === today() ? 0 : 1,
          );
      }
  }
  async saveSnapshot(v) {
    const x = v.snapshot,
      observed = x?.dataTimeStr || v.fetchedAt;
    this.put("snapshot:" + v.device.deviceSn, v);
    this.sql.exec(
      "INSERT OR IGNORE INTO telemetry VALUES(?,?,?,?)",
      v.device.deviceSn,
      observed,
      v.fetchedAt,
      await pack(v),
    );
  }
  async collect() {
    if (this.collectJob) return this.collectJob;
    this.collectJob = this.collectInner();
    try {
      return await this.collectJob;
    } finally {
      this.collectJob = null;
    }
  }
  async collectInner() {
    try {
      // Refresh inventory hourly. All device types are kept, including complete battery fields.
      if (
        !this.get("inventoryAt") ||
        Date.now() - this.get("inventoryAt") > 3600000
      ) {
        this.put("plants", await this.client.plants());
        this.put("devices", await this.client.devices());
        this.put("inventoryAt", Date.now());
        this.enqueue(30);
      }
      const snapshots = [];
      for (const d of this.devices().items) {
        try {
          const v = await this.client.snapshot(d.deviceSn);
          await this.saveSnapshot(v);
          snapshots.push(v);
        } catch {
          snapshots.push({ device: d, snapshot: null });
        }
      }
      for (const p of this.plants().items) {
        const id = String(p.id);
        const list = snapshots
          .filter(
            (x) =>
              String(x.device.plantId) === id && x.device.deviceType === "OG",
          )
          .map((x) => x.snapshot);
        const previous = this.get("current:" + id);
        const v =
          normalizeLiveSnapshots(list) ??
          (previous ? { ...previous, gridOn: null } : null);
        this.put("current:" + id, v);
        const timing = this.get("timing:" + id, {});
        if (v?.gridOn === true) {
          if (previous?.gridOn !== true) timing.gridOnSince = v.observedAt;
          timing.lastGridAt = v.observedAt;
        }
        this.put("timing:" + id, timing);
      }
      if (
        !this.get("dailyRefresh") ||
        Date.now() - this.get("dailyRefresh") >= 300000
      ) {
        this.enqueue(1);
        this.put("dailyRefresh", Date.now());
      }
      // One historical day per invocation stays within Workers subrequest budgets.
      const job = this.sql
        .exec("SELECT * FROM pending ORDER BY attempts,priority,date LIMIT 1")
        .toArray()[0];
      if (job) {
        try {
          const power = await this.client.chart({
              plantId: job.plant,
              date: job.date,
            }),
            soc = await this.client.chart({
              plantId: job.plant,
              date: job.date,
              kind: "soc",
            }),
            volts = [];
          for (const d of this.devices().items.filter(
            (d) => String(d.plantId) === job.plant && d.deviceType === "OG",
          ))
            volts.push(
              await this.client.chart({
                deviceSn: d.deviceSn,
                date: job.date,
                fields: ["acRInVolt", "devTempMin"],
              }),
            );
          await this.saveDay(
            job.plant,
            summarize(
              job.date,
              normalize(job.date, power, soc, volts),
              power.pvOutputKwh,
            ),
          );
          this.sql.exec(
            "DELETE FROM pending WHERE plant=? AND date=?",
            job.plant,
            job.date,
          );
        } catch {
          this.sql.exec(
            "UPDATE pending SET attempts=attempts+1 WHERE plant=? AND date=?",
            job.plant,
            job.date,
          );
        }
      }
      this.put("lastSync", new Date().toISOString());
      this.put("error", null);
      return { ok: true };
    } catch {
      this.put(
        "error",
        "Cloud collection failed. Check the configured solar login and provider availability.",
      );
      return { ok: false };
    }
  }
  async rpc(method, args) {
    if (method === "plants") return this.plants();
    if (method === "devices")
      return {
        ...this.devices(),
        items: this.devices().items.filter(
          (d) => !args[0] || String(d.plantId) === args[0],
        ),
      };
    if (method === "snapshot") {
      const v = this.get("snapshot:" + args[0]);
      if (v && Date.now() - Date.parse(v.fetchedAt) < 90000) return v;
      const fresh = await this.client.snapshot(args[0]);
      await this.saveSnapshot(fresh);
      return fresh;
    }
    if (method === "plant") {
      const id = args[0];
      if (!this.plants().items.some((p) => String(p.id) === id))
        throw new Error("Plant is not accessible to this account.");
      return this.client.plant(id);
    }
    if (method === "chart") return this.client.chart(args[0]);
    if (method === "device") return this.client.device(args[0]);
    if (method === "request") {
      const path = new URL(args[0], "https://shine-api.felicitysolar.com")
        .pathname;
      const allowed = [
        "/storageRealtimeData/display",
        "/storageRealtimeData/list_storageRealtimeData_new",
        "/device/device_warring_list",
        "/device/warring/group",
        "/device/get_energy_flow2",
      ];
      if (!allowed.includes(path))
        throw new Error("Read endpoint is not supported.");
      return this.client.request(...args);
    }
    throw new Error("Unknown read method.");
  }
  async dashboard(plant, n = 30, end = today()) {
    const p = this.plants().items.find((p) => String(p.id) === plant);
    if (!p) throw new Error("Select an accessible plant.");
    const key = plant + ":" + n + ":" + end,
      revision = this.get("dailyRevision"),
      cached = this.analysisCache.get(key);
    let result;
    if (
      cached &&
      cached.revision === revision &&
      Date.now() - cached.at < 300000
    )
      result = cached.result;
    else {
      const days = [];
      for (const date of dates(n, end)) {
        const row = this.sql
          .exec("SELECT data FROM daily WHERE plant=? AND date=?", plant, date)
          .toArray()[0];
        const stored = row ? await unpack(row.data) : null;
        days.push(summarize(date, stored?.samples || [], stored?.pvKwh));
      }
      result = analyze(days);
      this.analysisCache.set(key, { revision, at: Date.now(), result });
      if (this.analysisCache.size > 4)
        this.analysisCache.delete(this.analysisCache.keys().next().value);
    }
    const days = result.days.map((d) => ({ ...d }));
    const current = this.get("current:" + plant),
      timing = this.get("timing:" + plant, {});
    return {
      plant: { id: plant, name: p.plantName },
      updated: this.get("lastSync"),
      devices: this.devices().items.filter((d) => String(d.plantId) === plant),
      ...result,
      days,
      current: current ? { ...current, ...timing } : null,
      range: {
        days: n,
        start: days[0]?.date,
        end,
        observedDays: days.filter((d) => d.gridKnownHours > 0).length,
      },
      liveCheckedAt: this.get("lastSync")
        ? Date.parse(this.get("lastSync"))
        : null,
    };
  }
  async widget(plant) {
    const d = await this.dashboard(plant, 30),
      day = d.days.find((x) => x.date === today()),
      v = d.current;
    return {
      plant: d.plant.name,
      updated: d.updated,
      gridOn: v?.gridOn ?? null,
      gridVoltage: v?.voltage ?? null,
      battery: v?.soc ?? null,
      pvWatts: v?.pv ?? null,
      todayKwh: day?.pvKwh ?? null,
      gridHours: day?.gridKnownHours ? day.gridHours : null,
      nextWindow: d.next?.at ?? null,
      probability: d.next?.probability ?? null,
      observedAt: v?.observedAt ?? null,
      gridOnSince: v?.gridOnSince ?? null,
      lastGridAt: v?.lastGridAt ?? null,
      daily: d.days.slice(-7).map((x) => ({
        date: x.date,
        hours: x.gridKnownHours ? x.gridHours : null,
        observed: x.gridKnownHours,
      })),
    };
  }
  async fetch(req) {
    const u = new URL(req.url);
    try {
      if (u.pathname === "/collect" && req.method === "POST")
        return json(await this.collect());
      if (u.pathname === "/rpc" && req.method === "POST") {
        const b = await req.json();
        return json(await this.rpc(b.method, b.args || []));
      }
      if (u.pathname === "/limit" && req.method === "POST") {
        const { key } = await req.json(),
          window = Math.floor(Date.now() / 60000),
          row = this.sql
            .exec("SELECT * FROM login_limits WHERE key=?", key)
            .toArray()[0],
          count = row?.window === window ? row.count + 1 : 1;
        this.sql.exec(
          "INSERT OR REPLACE INTO login_limits VALUES(?,?,?)",
          key,
          window,
          count,
        );
        this.sql.exec("DELETE FROM login_limits WHERE window<?", window - 5);
        return json({ allowed: count <= 5 });
      }
      const plant =
        u.searchParams.get("plant") || String(this.plants().items[0]?.id || "");
      const days = Math.max(
        1,
        Math.min(180, Number(u.searchParams.get("days")) || 30),
      );
      if (u.pathname === "/status") {
        const pending = this.sql
            .exec("SELECT COUNT(*) AS count FROM pending")
            .toArray()[0].count,
          completed = this.sql
            .exec("SELECT COUNT(*) AS count FROM daily")
            .toArray()[0].count;
        return json({
          connected: true,
          cloud: true,
          plants: this.plants().items.map((p) => ({
            id: String(p.id),
            name: p.plantName,
          })),
          sync: {
            running: pending > 0,
            completed,
            total: pending + completed,
            error: this.get("error"),
            lastSync: this.get("lastSync"),
          },
        });
      }
      if (u.pathname === "/sync" && req.method === "POST") {
        const b = await req.json();
        this.enqueue(Math.max(1, Math.min(180, Number(b.days) || 30)));
        return json({ started: true });
      }
      if (u.pathname === "/import" && req.method === "POST") {
        const b = await req.json();
        if (!this.plants().items.some((p) => String(p.id) === b.plantId))
          throw new Error("Plant is not accessible.");
        if (!Array.isArray(b.days) || b.days.length > 180)
          throw new Error("Import up to180 daily records per request.");
        for (const day of b.days) {
          if (
            !/^\d{4}-\d{2}-\d{2}$/.test(day.date) ||
            !Array.isArray(day.samples) ||
            day.samples.length > 300
          )
            throw new Error("Invalid daily record.");
          await this.saveDay(
            b.plantId,
            summarize(day.date, day.samples, day.pvKwh),
          );
          this.sql.exec(
            "DELETE FROM pending WHERE plant=? AND date=?",
            b.plantId,
            day.date,
          );
        }
        return json({ imported: b.days.length });
      }
      if (u.pathname === "/widget") return json(await this.widget(plant));
      if (u.pathname === "/dashboard")
        return json(await this.dashboard(plant, days));
      if (u.pathname === "/patterns") {
        const start = u.searchParams.get("start"),
          end = u.searchParams.get("end"),
          n = Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
        if (!Number.isFinite(n) || n < 1 || n > 31)
          throw new Error("Request 1–31 days.");
        const d = await this.dashboard(plant, n, end);
        if (u.searchParams.get("samples") !== "true")
          for (const day of d.days) delete day.samples;
        return json({
          ...d,
          warning:
            "Cloud history uses stored provider charts. Missing reports and pending imports are unknown; predictions are probabilities.",
        });
      }
      if (u.pathname === "/day") {
        const date = u.searchParams.get("date") || today();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Invalid date.");
        const d = (await this.dashboard(plant, 1, date)).days[0];
        if (u.searchParams.get("samples") !== "true") delete d.samples;
        return json(d);
      }
      return json({ error: "Not found" }, 404);
    } catch {
      return json(
        {
          error:
            "Request failed. Check accessible plant/device IDs and provider availability.",
        },
        400,
      );
    }
  }
}
