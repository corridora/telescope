# Telescope Docker runtime

Build with the repository root as the Docker context. The package-directory
`.dockerignore` does not protect a root context; the root `.dockerignore`
excludes host dependencies, captures, generated output, and local credentials.

The default Compose service is a one-shot CLI runner. It does not start the
hosted Workers web app. Local UI and remote-agent commands are separate runtime
features, and should be used only with the matching command/configuration in the
installed Telescope version.

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

The implementation has not been validated by a Docker build or browser run as
part of this change; execute those checks when testing is requested.
