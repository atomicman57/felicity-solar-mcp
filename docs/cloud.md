# Run independently of your computer

The Cloudflare deployment serves the dashboard, authenticated MCP endpoint and widget summaries. A scheduled Worker collects data into a SQLite Durable Object every minute; collection continues while your Mac is asleep or off. The Mac menu bar app still needs the Mac to be on to display updates. An iPhone client fetches the cloud service independently, subject to iOS background-refresh limits.

This is a single-owner deployment. Use your own Cloudflare account and one Felicity account. It is not a shared service for multiple unrelated users.

## Resources and configuration

- One Worker with static dashboard assets and a once-per-minute Cron Trigger.
- One SQLite Durable Object, `SolarStore`, holding inventory, compressed measurements, daily analysis and the collection queue.
- One KV namespace, `OAUTH_KV`, holding OAuth clients, grants and owner sessions.
- Worker secrets `FELICITY_USER` and `FELICITY_PASS` for the owner account.
- Variable `PUBLIC_ORIGIN`, the canonical HTTPS origin, without a trailing slash or path.

The committed `wrangler.jsonc` contains a placeholder KV namespace ID. Copy it to the ignored `wrangler.local.jsonc`, replace that ID with your namespace ID and add your personal `account_id` and `vars.PUBLIC_ORIGIN`. Keep the Durable Object binding and migration intact. Do not commit your local configuration or private account data.

Authenticate Wrangler through your credential manager. Inject `CLOUDFLARE_API_TOKEN` into the child process rather than saving it in a shell profile or repository. A scoped token needs permission to deploy Workers scripts and manage the selected account's Workers KV namespace; Wrangler may also need account-read permission to discover the account. Restrict the token to the account used by this deployment. No DNS permission is needed for a `workers.dev` address.

Create the namespace using authenticated Wrangler:

```sh
npx wrangler kv namespace create OAUTH_KV
```

Supply the two Felicity secrets through your secret manager to `wrangler secret bulk --config wrangler.local.jsonc` on standard input, as a JSON object with keys `FELICITY_USER` and `FELICITY_PASS`. Do not create a plaintext credential file, include secret values in command arguments, or print the JSON. A central encrypted credential helper can launch Wrangler with the Cloudflare token and stream the Felicity object directly to its stdin. A first deployment without the Felicity secrets is safe: account data remains inaccessible and `/health` reports `ready: false`.

After configuration and secrets are in place:

```sh
npx wrangler deploy --config wrangler.local.jsonc
```

Check your Cloudflare plan's current [Worker limits](https://developers.cloudflare.com/workers/platform/limits/) and [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/), plus KV quotas before enabling continuous collection. This project does not automatically purchase or upgrade a plan.

## Sign in and connect clients

Open the HTTPS dashboard and sign in with the Felicity login configured in the Worker secrets. This checks the deployment's owner credentials; it does not allow arbitrary visitors to attach another Felicity account. The browser receives a secure, HTTP-only, same-site session cookie valid for 30 days. Logging out invalidates that browser session.

Use `https://YOUR-CLOUD-ORIGIN/mcp` as the remote MCP URL in clients that support Streamable HTTP with OAuth. Choose OAuth authentication and approve access on your dashboard origin. OAuth discovery, dynamic client registration and PKCE are handled by the Worker. A local stdio configuration continues to depend on the local computer until it is replaced by a remote connection.

| Scope            | Access                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `solar:read`     | The 14 read-only MCP tools, including raw account telemetry and history; also widget summaries |
| `widget:read`    | `/api/widget` summaries only; cannot call MCP tools                                            |
| `offline_access` | Allows the connection to request a refresh token                                               |

Access tokens expire after one hour. Refresh tokens have a 30-day maximum and a 30-day idle lifetime. Reconnect when a refresh token expires. The native sign-in flow registers its app callback, uses PKCE and keeps tokens in Keychain. Sharing a token with a WidgetKit extension requires correctly signed app and extension entitlements; an unsigned or ad-hoc build does not establish an iPhone installation.

The dashboard shell and `/health` are public. Account API responses require owner sign-in or a suitable OAuth token. Never connect this service using “No authentication.”

## What is collected

The collector refreshes plant/device inventory hourly and attempts a snapshot of every account device each minute. It preserves all returned raw measurement fields and stores each distinct observed snapshot in compressed form. A minute of polling does not guarantee a new minute of hardware data: the provider's upload interval still determines freshness.

At startup it queues the latest 30 days for each plant. Each collection run processes one queued plant/day, with power, SOC and inverter voltage charts. Today's charts are queued again every five minutes. The protected dashboard sync endpoint can request up to 180 recent days; the initial backfill is gradual, and availability depends on what Felicity retains. Existing daily records can be imported through the owner-only `/api/import` endpoint, up to 180 records per request.

Daily/pattern MCP tools read the cloud archive. Until backfill completes, historical coverage is incomplete. Pattern requests accept 1–31 days per call; use adjacent ranges for longer comparisons. Raw history, alarms and chart tools still query Felicity on demand, with pagination where available. Deployment does not automatically copy every historical row or alarm. The complete snapshot archive begins when cloud collection starts; it has no automatic retention cleanup in this version.

Derived analysis currently assumes `Africa/Lagos` and five-minute chart samples. Grid status is inferred from AC input voltage of at least 90 V; missing or stale readings remain unknown. Historical probabilities describe observed availability and are not promises about the next utility supply window.

## Verify before switching clients

The test command builds the Worker bundle before running the cloud tests:

```sh
npm ci --ignore-scripts
npm test
```

The cloud tests use synthetic data and exercise owner sign-in, private API access, OAuth/PKCE, token refresh, widget scope isolation, collection and the MCP protocol. After deployment, verify the actual HTTPS dashboard, authorize a remote MCP client, and check that observed cloud data continues to update while the local dashboard backend is stopped. A successful bundle or local test alone does not prove a live deployment.
