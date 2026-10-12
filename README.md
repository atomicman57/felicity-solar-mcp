# Felicity Solar Data MCP

An independent, MIT-licensed, read-only MCP server for the Felicity Solar Shine cloud. Ask your assistant about grid availability, solar generation, battery health, consumption, alarms and historical patterns.

Supports inverters, batteries and every device type returned by your account. Raw telemetry is preserved instead of reducing devices to a fixed set of battery properties. This is an unofficial integration, not a Felicity Solar product.

## Tools

| Tool                   | Data                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `list_plants`          | All accessible plants, following pagination                                         |
| `get_plant`            | Plant details, timezone, capacity and capabilities                                  |
| `list_devices`         | All accessible devices, models, firmware and metadata                               |
| `get_device_snapshot`  | Latest complete raw telemetry for any device                                        |
| `get_all_snapshots`    | Fleet telemetry with explicit individual failures                                   |
| `get_energy_flow`      | Plant grid, PV, battery and load flow                                               |
| `get_grid_status`      | Grid presence, voltage, measurement age, reporting interval                         |
| `get_available_fields` | Vendor measurement fields, display definitions and units                            |
| `get_chart`            | Intraday, monthly or yearly raw charts with selectable fields                       |
| `get_history_rows`     | Complete pageable raw measurements for a device/date                                |
| `get_device_alarms`    | Pageable device alarms with date filters                                            |
| `get_alarm_summary`    | Grouped plant alarms with date filters                                              |
| `get_daily_analysis`   | Grid hours, PV energy/peak, peak duration, battery minimum and energy totals        |
| `get_grid_patterns`    | Daily/week totals, weekday/hour probability map, best PV day and likely next window |

## Install

Requires Node.js 22 or newer.

```sh
npm ci --ignore-scripts
npm test
node src/server.mjs
```

Provide `FELICITY_USER` and `FELICITY_PASS` through your secret manager's process launcher. The server reads these at startup; it never writes them to disk. Do not put credentials in source, committed `.env` files, MCP configuration, URLs or logs. `FELICITY_TIMEZONE` defaults to `Africa/Lagos` and controls API wall-clock queries.

For Claude, Cursor, Codex or another stdio client, configure a secret-manager launcher that injects the two variables and executes `node /absolute/path/to/src/server.mjs`:

```json
{
  "mcpServers": {
    "felicity-solar": {
      "command": "/absolute/path/to/your-secret-manager-launcher",
      "args": []
    }
  }
}
```

Codex equivalent:

```toml
[mcp_servers.felicity-solar]
command = "/absolute/path/to/your-secret-manager-launcher"
args = []
startup_timeout_sec = 30
tool_timeout_sec = 180
```

Reload the client's MCP configuration or start a new session. Stdio starts the server automatically; it does not require the dashboard to be running.

## ChatGPT and remote clients

ChatGPT cannot directly launch a local stdio command. Connect using an authenticated remote deployment or OpenAI Secure MCP Tunnel. A loopback-only Streamable HTTP transport is included:

```sh
node src/server.mjs --http
```

It listens at `http://127.0.0.1:4318/mcp` (`FELICITY_MCP_PORT` overrides the port). It rejects browser-origin requests and unexpected Host headers. It deliberately cannot bind to a public interface. A tunnel or deployment must provide authenticated access; do not expose the private endpoint with an unauthenticated public tunnel. The local endpoint itself relies on the local OS trust boundary and has no bearer authentication.

## Example questions

- Is there grid power now? How old is that reading?
- Show every battery's cell voltages, temperatures, SOC and SOH.
- How many hours did we have grid power each day last month?
- Which weekdays and hours usually have power? Show the evidence coverage.
- Which day produced the most solar energy, and when did PV output peak?
- What was the lowest battery percentage, and how long was it below 20%?
- Show the inverter fault history and the vendor's fault descriptions.

## What “all data” means

All fields returned by the supported read endpoints are retained, except authentication material. Plant/device lists automatically follow pagination. Measurement rows and alarms expose pagination so clients can retrieve every page. Charts accept historical dates: use consecutive date/month queries to retrieve all history the provider retains. `get_grid_patterns` accepts up to 31 days per call; longer history is retrieved in adjacent ranges. The server does not automatically download your entire account history at installation.

Some fields may be missing, unsupported or restricted by your model/account. Nulls and missing reports are unknown, not zero. No inverter configuration, reset, deletion, alarm acknowledgement or remote-control tools are exposed.

## Measurement and analysis limits

- “Live” means the latest uploaded cloud reading. Device upload intervals determine freshness; fast polling cannot make the hardware report faster. Snapshots are cached for 15 seconds.
- Grid presence is inferred from AC input voltage >=90 V. Readings older than 15 minutes are unknown. Numeric vendor timestamps can use a different encoding from device-local `dataTimeStr`; grid status uses the explicit plant UTC offset.
- Raw tools support account devices in any timezone. Derived daily/pattern analysis currently supports `Africa/Lagos` and the observed five-minute chart cadence. Other timezones must use raw charts until analysis is generalized.
- PV energy uses the vendor's reported daily kWh when available, otherwise integrates observed samples. Watts are instantaneous power; kWh is accumulated energy. Peak duration means time at least 90% of that day's measured maximum, not time at exactly the maximum.
- Historical grid probabilities are estimates, not utility schedules. The next-window suggestion requires at least three observed days in that weekday/hour bucket and >=60% observed grid presence.
- SOC in plant charts may be an aggregate across batteries; use individual battery snapshots/history to compare battery banks.

Requests are paced, authentication is renewed in memory, responses are recursively filtered for credential fields, and tests use synthetic data only. No analytics, tracking, external logging or account telemetry is bundled.

## Development

```sh
npm test
npm audit
```

Tests cover credential filtering, fleet pagination, concurrent authentication and a real MCP protocol handshake. Cloud smoke tests are performed separately using a private account; no account data is included in this repository.

## Inspiration

Thanks to [RicardoSantos/mcp-fsolar](https://github.com/RicardoSantos/mcp-fsolar) for demonstrating Felicity battery data through MCP. This project has its own implementation and broader plant/inverter/grid/history tools. The login encryption key is Felicity's public cloud key, not a user secret.

Contributions for additional read endpoints, device models, sampling cadences and timezones are welcome.
