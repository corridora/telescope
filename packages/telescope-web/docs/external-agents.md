# Remote Telescope agents

The web UI is the controller and permanent result store. Agents make outbound
requests to it, run a single browser job at a time, and retain pending delivery
files until the controller acknowledges durable storage.

## Configure the controller

Apply the web application's database migrations, including the external-agent
tables. Configure `TELESCOPE_ADMIN_TOKEN` as an instance secret. If jobs use
headers, cookies, or HTTP authentication, also configure `TELESCOPE_JOB_SECRET`
with at least 32 characters. Those job fields are encrypted in the database with
AES-GCM; keep this key available while queued jobs exist. Rotating it without
retaining/decrypting pending records makes their secrets unavailable.

Open `/agents`, sign in, and create an agent credential. Save the displayed
credential in a private file on the agent machine; it is shown only once. Agent
tokens and the administrator token are different credentials. The agent does not
need R2, D1, or administrator storage credentials.

## Start an agent

The installed CLI includes the agent command:

```sh
telescope agent --controller https://telescope.example.com \
  --tokenFile ./agent.token --spoolDir ./agent-spool \
  --allowHosts example.com,cdn.example.com
```

Make the token file readable only by the agent's runtime user. Supply an explicit
hostname/IP allowlist; `*.example.com` permits subdomains. Include the target's
required asset, API, and redirect hosts. The policy is enforced for browser
requests, including redirects; `localhost` refers to the agent machine/container.
Output paths and result upload destinations are owned by the service.

HTTPS is required except for loopback. For a deliberately private HTTP development
controller, use `--allowInsecureHttp`; this is an explicit transport exception and
does not disable redirect or credential checks. Use the platform's CA configuration
for a private TLS certificate rather than disabling verification.

An agent registers installed browser names, available version information,
platform/architecture, emulation device names, and optional features. A version
that cannot be read safely is explicitly unknown until the capture; the HAR
records the browser actually used. Missing capabilities are errors, not silent
browser substitutions. Network throttling is advertised only when the agent's
Linux environment exposes the required module; runtime permission checks still
apply.

## Run and inspect

Open `/run`, select the enrolled agent and browser, and enter an HTTP/HTTPS target.
An optional device uses a Playwright device name. The form supports advanced
validated test settings, without exposing shell commands or arbitrary file paths.

The job page persists progress, cancellation, execution attempts, and result
delivery independently of the browser tab. Once stored, its result link uses the
controller's own data and stays usable after the agent stops. Private remote
captures and downloads require the instance administrator session. Instance
content review can leave a stored result pending or restricted.

Cancellation requests reach the agent on its next heartbeat. An expired execution
lease is reconciled as interruption; retries create a new attempt and do not
promise that target interactions happen exactly once. Do not automatically retry
journeys that may have already changed application state.

## Trusted journeys

Provision `.js`/`.mjs` scripts in a read-only directory and set
`TELESCOPE_SCRIPTS_DIR` before starting the agent. Scripts are listed by stable ID
and entry-file SHA-256; the agent verifies the selected hash before execution.
The controller sends an allowed ID/hash reference, never script source or a
controller-local filesystem path. Restart the agent after changing its registered
scripts or capabilities. Keep script dependencies immutable alongside the entry
file; the entry hash does not freeze an arbitrary import graph.

## Delivery, limits, and recovery

New captures use per-artifact streaming transfer with checksums and a final
publication receipt, rather than loading a large ZIP into a Worker. Current
limits are 10,000 files and 2 GiB per capture, with 64 MiB per ordinary artifact,
tighter JSON/HAR/manifest limits, and a bounded metadata manifest. A larger
individual file is rejected explicitly and retained in the agent spool. A future
multipart-artifact protocol is required beyond those per-file limits.

The agent retries retained deliveries with backoff. A controller restart or lost
receipt does not require another browser execution. An acknowledged spool is
removed only after its result ID and checksum match the controller receipt.
Superseded attempts are retained as blocked local spool entries; inspect/export
them deliberately before cleanup. The agent stops accepting new work when its
retained spool reaches its capacity boundary.

Keep the spool on persistent storage and use the same directory on restart. Only
one agent process may own a spool directory. Normal shutdown cancels the active
worker, and restart recovery preserves available partial output. Do not remove a
pending spool or its capture files merely because the browser run finished.

The controller exposes a privileged `/api/agents/reconcile` maintenance action;
the deployment's scheduled entry point also reconciles expired leases. No user tab
or live worker connection is required for controller-side timeout recovery.

Native and container agents share the same versioned protocol. See the Docker
deployment examples for shared-network and isolated-network controller addresses.
