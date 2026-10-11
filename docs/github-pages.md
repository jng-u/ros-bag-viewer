# GitHub Pages deployment

This deployment implements the maintainer's explicit request to publish the viewer source to `jng-u/ros-bag-viewer` and prepare its GitHub Pages site. This limited authorization does not select a license, publish an npm package, provision credentials or paid infrastructure, or certify production readiness.

The repository includes [`.github/workflows/pages.yml`](../.github/workflows/pages.yml), which validates and builds the static viewer on every push to `main` and can also be started manually with **Run workflow**. A successful deployment for `jng-u/ros-bag-viewer` is published at:

<https://jng-u.github.io/ros-bag-viewer/>

## One-time repository setting

After pushing the workflow to GitHub, open **Settings → Pages** in `jng-u/ros-bag-viewer` and set **Build and deployment → Source** to **GitHub Actions**. The repository owner may need to make this setting manually. Then push to `main` or run **Deploy GitHub Pages** from the repository's **Actions** tab.

The workflow uses Node.js 22 and pnpm 9.15.5, installs the frozen lockfile, and runs lint, typecheck, and unit tests before building. `actions/configure-pages` supplies the repository-aware base path to Vite, so generated assets work below `/ros-bag-viewer/`. The uploaded Pages artifact is `apps/web/dist-web`.

## Static-host behavior

GitHub Pages serves only the browser application; it does not run the repository's hosted share service or ROS bridges.

- Local MCAP, ROS1 BAG, and ROS2 BAG data is read and processed in the visitor's browser. Opening local data does not upload it to GitHub Pages.
- **SHARE** creation is unavailable in the static build because it requires the separately deployed hosted service.
- **URL** can open an external indexed MCAP only when that HTTPS origin supports byte-range requests and permits the Pages origin through CORS.
- **LIVE** still requires a separately operated secure `wss://` relay that permits the Pages origin and meets the viewer's authentication and protocol requirements.
- ROS2 SQLite uses SQLite WASM's OPFS SAH pool. Use a supported browser in a secure context; the HTTPS Pages site provides that secure context. This path does not require Pages to emit cross-origin isolation headers.

GitHub Pages makes the viewer publicly reachable, but this workflow is not certification of a robot network, relay, remote-data host, identity system, or other production deployment. Operators remain responsible for TLS, credentials, CORS/origin policy, authorization, network policy, storage, and validation of any external service.

## Local Pages verification

With Firefox and `geckodriver` installed, run from the repository root:

```bash
VITE_BASE_PATH=/ros-bag-viewer/ VITE_STATIC_HOST=true corepack pnpm build:web
corepack pnpm test:e2e:pages
```

This serves the built viewer under the project path without an API or COOP/COEP headers. The browser suite opens all three demos, verifies ROS2 OPFS and rendering, checks that SHARE stays disabled and cannot issue an upload, and exercises seeking and workspace interactions.
