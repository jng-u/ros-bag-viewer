# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated to the existing repository: TypeScript, vanilla browser APIs, Vite, WebGL2, SQLite WASM, and a Caddy Docker image. The deployed UI does not require ROS packages in the browser container.

## Users

Robotics developers and operators reviewing ROS 1 or ROS 2 recordings and observing authorized live topics from a desktop browser.

## Product Purpose

Provide a lightweight RViz-like web viewer with one interaction model for local recordings and secured online observation. Success means a user can open the Docker-served application, drag in a supported recording, discover topics, add a display, seek the timeline, and understand failures without installing the repository toolchain locally.

## Positioning

One bounded, source-neutral display lifecycle spans ROS 1, ROS 2, recorded, hosted, and live data while keeping robot-facing connectivity explicitly read-only.

## Operating Context

The application runs from a Docker image and is opened in a desktop browser. Local recording bytes stay in the browser. Live observation is configured against a separately authorized relay endpoint.

## Capabilities and Constraints

- WebGL2 is the required rendering baseline.
- Local MCAP, ROS 1 bag, and ROS 2 SQLite bag bundles are browser-runnable recorded-source lanes. ROS 2 folders are selected as a directory or as `metadata.yaml` plus all referenced `.db3` parts.
- PointCloud2 and Path use bounded geometry displays; raw and compressed Image messages use a bounded Canvas2D raster display; every topic exposes a bounded hexadecimal/ASCII Raw inspector.
- The product is read-only. ROS publish, service, action, parameter mutation, and arbitrary bridge operations are excluded.
- Resource limits, source epochs, payload ownership, TF/time diagnostics, and error recovery remain explicit.
- Public product naming, public hosting, licensing, credentials, and production certification remain undecided.

## Brand Commitments

The working name remains `ros-web-viewer`. The interface should pursue iridescence-like technical restraint, density, and lightness without copying its native UI.

## Evidence on Hand

Repository-local deterministic fixtures, tests, semantic shell evidence, security gates, and conformance artifacts exist. There is no approved public corpus, public deployment, production ROS endpoint, or production certification.

## Product Principles

1. Show truthful source, time, TF, and failure state before adding breadth.
2. Keep the main viewport dominant and operational controls compact.
3. Bound every untrusted input and retained resource.
4. Keep local data local and live connectivity read-only.
5. Prefer one normalized lifecycle over source-specific UI forks.

## Accessibility & Inclusion

Keyboard navigation, visible focus, reduced motion, zoom operation, semantic regions, and status/error announcements are required for the desktop web surface.
