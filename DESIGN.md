# Design

## Direction

The deployed viewer is an instrument surface rather than a dashboard: a compact survey console organized around one dominant spatial field. The scene is the product; source, topics, inspector, and time form a thin calibrated frame around it.

## Visual system

- Abyssal blue-black surfaces keep the WebGL field dominant without decorative glass.
- Cyan is reserved for active data, successful connectivity, focus, and point geometry; amber marks temporal or degraded state; red is failure only.
- Hairline rules, compact controls, fixed-width measurements, and restrained sans-serif copy borrow from field instrumentation and iridescence's technical lightness.
- Panels are structural regions, not independent cards. Corners remain nearly square and elevation comes from hierarchy rather than shadows.
- The viewport carries a real measurement grid, axis glyph, bounded resource telemetry, and source-time feedback.

## Interaction

- A recording can be selected or dropped directly into the viewport.
- Topic rows reveal only compatible display actions.
- Timeline movement advances the source epoch and redraws the active display.
- Geometry uses the WebGL2 surface, images use a contained Canvas2D raster surface, and Raw inspection shows a bounded 4 KiB hex/ASCII preview in the inspector.
- Errors remain in-place with recovery language; source-specific failures are reported instead of being hidden behind an empty viewport.
- Motion is limited to transport and source transitions and stops under reduced-motion preference.

## Responsive boundary

This is a desktop operations surface with a 960 px minimum width. Between 960 and 1120 px, side regions narrow and secondary viewport telemetry collapses. Mobile and VR are outside the product scope.
