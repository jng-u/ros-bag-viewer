# Hosted indexed MCAP range source

The viewer's **URL** entry opens a remote MCAP without downloading the full object.

This is the portable direct-range profile used by the Docker viewer. It is intentionally distinct from the M4 provider-neutral signed-manifest/grant reference contract: deployments that require manifest signatures, per-range grant issuance, revocation, or retention policy must place that service in front of this byte-range interface. The browser does not claim to implement those server-side controls by accepting a direct URL.

Required server behavior:

- HTTPS, except loopback HTTP development
- immutable object identity through `ETag` or `Last-Modified`
- HTTP `Range: bytes=start-end` support returning `206`
- exact `Content-Range` and payload length
- CORS permission for the viewer origin
- `Access-Control-Expose-Headers: Content-Range, ETag, Last-Modified`
- MCAP summary and message indexes; remote sequential scans are refused

An optional `#capability=...` or `#cap=...` URL fragment is stripped from the request URL and sent as `Authorization: Bearer ...`. The input is cleared immediately on submission; the fragment is not left in the DOM, request paths, logs controlled by the viewer, source labels, or the inspector.

All remote reads pass through the same bounded range reader used by local indexed MCAP. Every response—not only the initial probe—is checked for exact `Content-Range` and byte length, and each request carries `If-Range` with the immutable validator. The shipped test starts an HTTP range server, proves every request carries an exact byte range and capability header, decodes a midpoint point cloud, and verifies transferred bytes remain below the recording size.
