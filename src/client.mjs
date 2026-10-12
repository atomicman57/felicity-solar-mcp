import { publicEncrypt, constants } from "node:crypto";
import { readFile } from "node:fs/promises";

// Remove authentication material from nested vendor objects before returning data.
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([k]) =>
            !/password|passwd|token|secret|authorization|cookie|api.?key/i.test(
              k,
            ),
        )
        .map(([k, v]) => [k, redact(v)]),
    );
  return value;
}
export class FelicityClient {
  constructor({
    user = process.env.FELICITY_USER,
    pass = process.env.FELICITY_PASS,
    fetcher = fetch,
    timeZone = process.env.FELICITY_TIMEZONE || "Africa/Lagos",
  } = {}) {
    this.user = user;
    this.pass = pass;
    this.fetcher = fetcher;
    this.timeZone = timeZone;
    this.token = null;
    this.expiry = 0;
    this.queue = Promise.resolve();
    this.last = 0;
    this.inflight = new Map();
    this.cache = new Map();
  }
  stamp() {
    return new Date().toLocaleString("sv-SE", { timeZone: this.timeZone });
  }
  async request(
    endpoint,
    body,
    { method = "POST", login = false, retry = 0 } = {},
  ) {
    if (!login) await this.authenticate();
    const job = this.queue.then(async () => {
      await new Promise((r) =>
        setTimeout(r, Math.max(0, 700 - (Date.now() - this.last))),
      );
      this.last = Date.now();
      const response = await this.fetcher(
        "https://shine-api.felicitysolar.com" + endpoint,
        {
          method,
          headers: {
            "Content-Type": "application/json",
            Node: "INT",
            source: "WEB",
            lang: "en_US",
            ...(!login ? { Authorization: this.token } : {}),
          },
          ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
          signal: AbortSignal.timeout(30000),
        },
      );
      if (!response.ok) throw new Error(`Felicity HTTP ${response.status}`);
      return response.json();
    });
    this.queue = job.catch(() => {});
    const result = await job;
    if (result.code !== 200) {
      if (!login && retry === 0 && [401, 403].includes(result.code)) {
        this.token = null;
        return this.request(endpoint, body, { method, retry: 1 });
      }
      if (retry < 3 && /frequen|too many/i.test(result.message || "")) {
        await new Promise((r) => setTimeout(r, 3000 * 2 ** retry));
        return this.request(endpoint, body, {
          method,
          login,
          retry: retry + 1,
        });
      }
      // Do not echo vendor messages, which sometimes contain request/auth material.
      throw new Error(
        `Felicity rejected request (${result.code}); check account permissions or session.`,
      );
    }
    return login ? result.data : redact(result.data);
  }
  async authenticate() {
    if (this.token && Date.now() < this.expiry) return;
    if (this.authJob) return this.authJob;
    this.authJob = (async () => {
      if (!this.user || !this.pass)
        throw new Error(
          "Configure FELICITY_USER and FELICITY_PASS using a secret manager.",
        );
      const key = await readFile(new URL("./public-key.pem", import.meta.url));
      const d = await this.request(
        "/userlogin",
        {
          userName: this.user,
          password: publicEncrypt(
            { key, padding: constants.RSA_PKCS1_PADDING },
            Buffer.from(this.pass),
          ).toString("base64"),
          version: "1.0",
        },
        { login: true },
      );
      if (typeof d?.token !== "string")
        throw new Error("No session returned by Felicity.");
      this.token = d.token;
      this.expiry = Date.now() + 5 * 3600000;
    })();
    try {
      await this.authJob;
    } finally {
      this.authJob = null;
    }
  }
  async memo(key, ttl, fn) {
    const old = this.cache.get(key);
    if (old && Date.now() - old.at < ttl) return old.value;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = fn();
    this.inflight.set(key, p);
    try {
      const value = await p;
      this.cache.set(key, { at: Date.now(), value });
      return value;
    } finally {
      this.inflight.delete(key);
    }
  }
  async pages(endpoint, body = {}) {
    const all = [];
    for (let pageNum = 1; pageNum <= 100; pageNum++) {
      const d = await this.request(endpoint, {
        ...body,
        pageNum,
        pageSize: 100,
      });
      const rows = d?.dataList;
      if (!Array.isArray(rows))
        throw new Error("Unexpected Felicity pagination response.");
      all.push(...rows);
      if (
        rows.length < 100 ||
        (Number(d.total) > 0 && all.length >= Number(d.total))
      )
        return { items: all, complete: true };
    }
    return {
      items: all,
      complete: false,
      warning: "Pagination safety limit reached; query a narrower scope.",
    };
  }
  plants() {
    return this.memo("plants", 60000, () =>
      this.pages("/plant/list_condition_plant"),
    );
  }
  devices(plantId) {
    return this.memo("devices:" + plantId, 60000, () =>
      this.pages("/device/list_device_all_type", {
        ...(plantId ? { plantId } : {}),
        deviceType: "",
        scope: 0,
      }),
    );
  }
  async plant(id) {
    if (!(await this.plants()).items.some((p) => String(p.id) === id))
      throw new Error("Plant is not accessible to this account.");
    return this.memo("plant:" + id, 60000, () =>
      this.request("/plant/plantDetails", {
        plantId: id,
        currentDateStr: this.stamp(),
      }),
    );
  }
  async device(sn) {
    const d = (await this.devices()).items.find((x) => x.deviceSn === sn);
    if (!d) throw new Error("Device is not accessible to this account.");
    return d;
  }
  async snapshot(sn) {
    const d = await this.device(sn);
    return this.memo("snapshot:" + sn, 15000, async () => ({
      device: d,
      fetchedAt: new Date().toISOString(),
      snapshot: await this.request("/device/get_device_snapshot", {
        deviceSn: sn,
        deviceType: d.deviceType,
        dateStr: this.stamp(),
      }),
    }));
  }
  async chart({
    plantId,
    deviceSn,
    date,
    period = "hour",
    kind = "power",
    fields = [],
  }) {
    if (plantId) await this.plant(plantId);
    else await this.device(deviceSn);
    const body = {
      ...(plantId ? { plantId } : { deviceSn }),
      chartScope: plantId ? 1 : 0,
      chartDrawingType: kind === "energy" ? 1 : 0,
      chartType: 1,
      chartScopeType: kind === "soc" ? 3 : kind === "energy" ? 2 : 0,
      timeDimension: period,
      dateStr: date + " 23:59:59",
      field: fields,
    };
    return this.memo("chart:" + JSON.stringify(body), 30000, () =>
      this.request("/storageRealtimeData/chart_storageRealtimeData_mate", body),
    );
  }
}
