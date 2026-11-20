# Context for Claude sessions

Prototype of **onboarding** for the Telemetry product, built on the Insights prototype (github.com/unco/Telemetry). See README.md for scenarios and the model.

## Decisions agreed with the user (Nov 2026)
- Default for a newly connected device is "data secure": nothing leaves except update traffic with the Canonical Snap Store. The store is the only default connector, modelled as a destination (so its volume shows) and visually distinct (orange). It can be replaced with the customer's own store, not removed; removing it would cut devices off from updates (the pipe is bidirectional).
- Groups are queries saved as static or dynamic. A group does nothing on its own; only connectors move data, so the connector setup is where the group is chosen and where escaping data is previewed. Changeable attributes in dynamic groups are a feature. Static groups never drop members (flagging drift from the query is a future improvement).
- Groups are the same objects as Landscape's (shared, editable from either surface), not imported.
- A device matching several connectors' groups has each packet delivered to every destination (fan-out). Shares of data leaving devices can therefore add up to more than 100%.
- Destinations have their own menu item (created inline from a connector or beforehand) because the page makes auditing easy.
- A connector chooses which snaps (publishers) it carries: all snaps (including ones installed later) or only chosen ones.
- Data flow keeps the Insights columns: Device → Publisher (snap) → Policy → Destination. It starts ungrouped (by device, with the Insights ladder).
- Data flow has the Insights View dropdown, starting on Neutral (monochrome); no colouring by outcome or destination (clicking a node traces its path, which covers 'where does this go'). Both ends group: Group devices by and Group destinations by. Only the Canonical destination has an orange bar (not snapd or update traffic); Canonical destinations come first.
- Sankey widths are volume (shows the effect of shaping). Counts can run to millions, so they are not used as widths.
- Menu: Overview (home icon, landing page) · Groups · Policies · Connectors · Destinations · Data flow (formerly Insights; can still hold insights) · Settings.
- Onboarding is a module on the Overview, and the only module there until setup is complete. Each step explains its purpose and has "Take me there" to the real page, which shows a banner. Steps are derived from state, so they work for any new joiner; steps done by someone else show who did them.
- Step 1 is connecting at least one device: with zero devices, groups, policies and connectors are locked. Inviting colleagues and adding destinations are available from the start. With Landscape linked, devices are pointed at telemetry from Landscape in one action. Diagnostics rank causes by what the server can see (rejected attempts first).
- "About you" asks what they want to do first (multi-select plus primary). It orders policy templates.
- Governance (approvals) is not in the MVP. Connectors go live on creation; other admins are notified; changes are logged. The Tasks module notes that approvals arrive later.
- After setup, the Overview shows Tasks (act), Insights (know, each links into Data flow), Recent changes, Destination health. At least one insight after 7 days uses the Data flow filters (the health insight: Show me sets View Device health, Group devices by Site and traces its destination). Before data builds up, Insights shows "first insights after about 24 hours" (demo link skips ahead 7 days).

## Jig
- Right-hand drawer ("Jig" tab) with prototype controls; the user asked for it to change things like whether devices are set up or whether someone set up a group before them. Keep demo controls there, not in Settings.

## Writing style
- Plain, factual UI copy. No em dashes. Sentence case.
- Vanilla-inspired styling from the Insights prototype (`css/app.css`); additions go in `css/onboarding.css` with `ob-` prefixes.

## Deployment
- Bump the `?v=` cache-busting query on the CSS/JS links in index.html with each change.
