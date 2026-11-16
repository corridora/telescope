# Telescope Docker runtime

Build with the repository root as the Docker context. The package-directory
`.dockerignore` does not protect a root context; the root `.dockerignore`
excludes host dependencies, captures, generated output, and local credentials.

The default Compose service is a one-shot CLI runner. The additional examples
use `local` as a persistent UI/controller and `agent` as an outbound executor.
The local controller supports agent enrollment, job dispatch, and instance-owned
result storage. It does not require the hosted Workers deployment.

Runtime defaults:

- Linux AMD64, Node.js 24, and lockfile-matched Playwright browser binaries.
- Non-root `node` user, headless browsers, init/process reaping, and a 30-second
  stop grace period.
- A persistent results bind mount and private, bounded 1 GB shared memory.
- The checked-in Chromium sandbox seccomp profile, with no additional Linux
  capabilities for normal tests.
- Optional native-Linux traffic shaping through `telescope-throttled`, explicitly
  selected with the `throttling` Compose profile.

The default results mount resolves relative to `docker-compose.yml`, so it is
`packages/telescope/results/` when using the documented root command. Named
volumes or another writable host directory can replace that mount. Captures
remain after a one-shot container is removed; explicitly removing the storage
removes the captures.

Use container service names and container ports for a target on the same
user-defined Docker network. A target on another network needs an intentionally
reachable host/published endpoint or gateway. The runner's `localhost` is the
runner container, rather than another target container. Configure application
redirect and asset URLs as well as the initial test URL.

## Standalone UI, runner, and target in one container

Before starting a UI/controller, generate a private administrator token once and
keep it in your protected deployment environment. Reuse the same value on
restart; do not put it in the image, target app, or scoped agent credential file.
The token must contain 24–256 letters, digits, underscores, or hyphens:

```bash
export TELESCOPE_LOCAL_TOKEN="$(openssl rand -hex 32)"
```

From the repository root, start the standalone example:

```bash
docker compose -p telescope-local \
  -f packages/telescope/docker/compose.standalone.yml up --build -d
```

Open `http://127.0.0.1:4321`, unlock the workspace with your administrator token,
then run a local test against `http://127.0.0.1:3000/`. Here the target and the browser are in the same
container. The target redirects `/` to `/product`, loads a stylesheet and script
from relative URLs, and calls `/api/status`. Its **Add to basket** and
**Checkout** controls preserve a small session-storage value for multi-step
journey examples. The fixture's target port is not published to the host.

The example's `standalone.mjs` starts the deterministic target before the local
workspace and forwards shutdown signals to the workspace. It keeps the target
alive during bounded workspace finalization. The UI/runner saves to `/data`,
backed by the Compose project's named volume; the fixture and browser share the
same container resource budget.

Stop the service while retaining saved definitions and captures:

```bash
docker compose -p telescope-local \
  -f packages/telescope/docker/compose.standalone.yml down
```

Reusing the same project name reuses its data volume. Removing that volume is an
explicit deletion of the local library. For a real application, use the normal
image entry point with command arguments
`local --host 0.0.0.0 --port 4321 --resultsDir /data --no-open` and a persistent
`/data` mount instead of the demonstration supervisor/target. Keep the UI port
published on host loopback unless an authenticated deployment is deliberately
configured.

## Controller, agent, and target on the same network

Keep the stable `TELESCOPE_LOCAL_TOKEN` configured above. Start the controller
and app first, without the agent overlay:

```bash
docker compose -p telescope-shared \
  -f packages/telescope/docker/compose.shared-network.yml up --build -d
```

Open `http://127.0.0.1:4321/agents`, unlock with the administrator token, and
enroll a dedicated agent. Save its one-time scoped credential in a private file
outside the repository. The file must be readable by container UID 1000. Keep
the administrator token and this agent credential separate.

Now supply the credential file path and include the agent overlay:

```bash
export TELESCOPE_AGENT_TOKEN_FILE=/absolute/private/telescope-agent.token

docker compose -p telescope-shared \
  -f packages/telescope/docker/compose.shared-network.yml \
  -f packages/telescope/docker/compose.shared-agent.yml up --build -d
```

The base file contains no reference to the agent secret, so initial controller
startup does not require a credential that has not been issued yet. The overlay
mounts the scoped credential only into the agent at `/run/secrets/agent_token`,
using [Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/).

The controller, agent, and app share the user-defined `execution` network. The
agent contacts `http://controller:4321`, with explicit `--allowInsecureHttp` for
this trusted Docker development network. The controller allows that internal
Host name through `TELESCOPE_ALLOWED_HOSTS`; the browser uses the published
`http://127.0.0.1:4321` UI origin.

Wait for the enrolled agent to appear online in `/agents`, then open `/run`,
select it, and submit `http://app:3000/`. The target listens on its container
interface and exposes no host port. Compose requires controller `/health` and
target `/healthz` readiness before starting the agent. The controller's Agents
view remains the source of browser capability/worker readiness.

The agent permits only `app` through `--allowHosts app`. Update that explicit
allowlist for real applications, including intended asset/redirect hosts. The
browser does not contact `app:3000` or the agent directly. Results are stored in
the controller's `controller-data` volume; the separate `agent-spool` volume
holds only pending delivery. Accepted results remain viewable after agent loss.

## Controller, agent, and target on separate Docker networks

This example isolates all three roles. Stop the shared-network example first
if it is using host port 4321. Keep the administrator token configured and
start the base services before creating an agent credential:

```bash
docker compose -p telescope-isolated \
  -f packages/telescope/docker/compose.separate-networks.yml up --build -d
```

Open `http://127.0.0.1:4321/agents`, unlock, enroll this instance's agent, and
save the credential to a separate private file. Then start the agent overlay:

```bash
export TELESCOPE_AGENT_TOKEN_FILE=/absolute/private/telescope-isolated-agent.token

docker compose -p telescope-isolated \
  -f packages/telescope/docker/compose.separate-networks.yml \
  -f packages/telescope/docker/compose.separate-agent.yml up --build -d
```

The controller joins only the internal `control` network, the agent joins only
`execution`, and the app joins only the internal `target` network. Two fixed
upstream proxies provide the intentional paths:

- `controller-gateway` joins `execution` and `control` and forwards to
  `controller:4321`. The agent uses `http://controller-gateway:4321` with the
  explicit development HTTP flag. The controller's allowed Host names include
  `controller-gateway`.
- `gateway` joins `execution` and `target` and forwards to `app:3000`. In the
  controller's `/run` UI, select the agent and submit `http://gateway:3000/`.

The proxies take one fixed upstream from administrator-controlled environment
settings. Incoming request URLs cannot select an upstream. No direct
agent-to-controller or agent-to-app network membership, service-name route, or
shared writable result store is assumed. The controller UI is independently
published on host loopback.

Readiness checks traverse each gateway to the correct upstream (`/health` for
the controller and `/healthz` for the target). The app uses relative redirects
and CSS/script/API URLs, preserving the browser-visible target-gateway origin.
These are HTTP development gateways, not production TLS/WebSocket proxies.
Configure those capabilities and host/certificate expectations explicitly for
a real deployment.

## Different Docker hosts or an existing hosted controller

An agent can also connect to an existing local/hosted controller at a routable
HTTPS URL. Enroll the agent on that destination instance, set
`TELESCOPE_AGENT_TOKEN_FILE` to its scoped credential, and use a dedicated
persistent spool. For example, after building the `telescope` image using the
package README:

```bash
export TELESCOPE_CONTROLLER_URL=https://results.example.com

docker run --rm --init --shm-size=1g \
  --security-opt seccomp=packages/telescope/docker/seccomp_profile.json \
  --mount type=bind,src="${TELESCOPE_AGENT_TOKEN_FILE}",dst=/run/secrets/agent_token,readonly \
  --mount type=volume,src=telescope-agent-spool,dst=/data \
  telescope agent --controller "${TELESCOPE_CONTROLLER_URL}" \
  --tokenFile /run/secrets/agent_token --allowHosts example.com --spoolDir /data/spool
```

Use the intended target hostname(s) in `--allowHosts`. No inbound agent port or
Docker socket is needed. Across hosts, remove the development HTTP exception
and provide verified TLS, DNS, routing, and firewall access to the controller.
A private CA can be supplied with an operator-mounted certificate and Node's
trust configuration. The local controller's default loopback-published UI port
needs an intentionally configured HTTPS ingress before a remote host can reach
it; changing an agent URL alone does not publish that port.

Matching network/volume names on different Docker hosts do not connect them.
For a remote target, use its routable URL or an explicit published/gateway
endpoint. `host.docker.internal` refers to the runner's Docker host, not a
second host; native Linux may require a `host-gateway` mapping. A port published
only to host loopback must not be assumed reachable from another bridge or host.

## Deployment boundaries and operation

- Local examples use the stable `TELESCOPE_LOCAL_TOKEN` administrator session.
  A hosted Workers controller instead uses `TELESCOPE_ADMIN_TOKEN` in protected
  deployment settings. Neither administrator token belongs in the agent's
  scoped token file or a target container.
- Keep enrollment credentials, pending spools, and result stores scoped to their
  respective instances. Share neither writable catalogs nor browser profiles
  across unrelated workers.
- Use `docker compose ... down` for ordinary shutdown; retain named volumes.
  Container removal is not result deletion. Before intentional volume removal,
  resolve pending deliveries and back up the durable result library as needed.
- The browser/runner must reach all target assets and redirects. The controller
  needs only its outbound-agent protocol, so successful controller registration
  alone does not prove target reachability.
- Compose health checks cover the local HTTP services in these examples. They
  do not run a performance test or prove browser capability; use the UI's agent
  status and explicit test requests for those operations.
- No example grants the Docker socket, `--privileged`, host networking,
  `NET_ADMIN`, or unconfined seccomp. Traffic shaping remains the separately
  selected native-Linux profile documented in the package README.

## Sandbox profile source

`seccomp_profile.json` is based on Microsoft's Apache-2.0-licensed Playwright
repository at
[`v1.61.1/utils/docker/seccomp_profile.json`](https://github.com/microsoft/playwright/blob/v1.61.1/utils/docker/seccomp_profile.json).
It retains a deny-by-default syscall policy and permits `clone`, `setns`, and
`unshare` for Chromium's user namespaces. The local adaptation returns `ENOSYS`
for `clone3` so modern glibc can fall back to `clone`, matching the
[Docker runtime's fallback convention](https://github.com/moby/moby/pull/42681).
Keep it aligned with the Playwright
version when upgrading. See the [Playwright Docker guide](https://playwright.dev/docs/docker)
for the upstream runtime recommendations.

These implementations and Compose examples have not been validated by builds,
container startup, health checks, or browser runs as part of this change.
Execute those checks when testing is requested.
