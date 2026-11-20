# Telemetry · Onboarding prototype

A dependency-free prototype of first-run onboarding for the Telemetry product. It builds on the Sankey and data from the [Insights prototype](https://github.com/unco/Telemetry).

Open `index.html` in a browser, or serve the folder (`python3 -m http.server`). There is no build step. All data is synthetic, and state is kept in `localStorage` per scenario.

## Scenarios

The scenario is set in the URL or in **Settings › Demo scenario**.

| Parameter | Values | What it changes |
|---|---|---|
| `fleet` | `zero`, `hobby`, `mid` (default), `enterprise` | `zero` starts with no connected devices. `hobby` has 6 devices, `mid` 38 and `enterprise` 5,000 |
| `landscape` | `1` (default), `0` | Linked: devices can be pointed at telemetry from Landscape in one step, and groups are shared. Not linked: an enrolment command is shown |
| `joiner` | `1` | You were invited by Ana Ruiz, who has already created a group. Steps someone else did show "Done by Ana Ruiz" |

Examples: `index.html?fleet=zero`, `index.html?fleet=hobby&landscape=0`, `index.html?fleet=mid&joiner=1`.

## Navigation

Overview (home) · Groups · Policies · Connectors · Destinations · Data flow · Settings.

- **Overview** is the landing page. Until setup is complete, onboarding is its only module. After that it shows Tasks, Insights, Recent changes and Destination health. The menu stays the same throughout.
- **Onboarding steps:** connect your first device → about you → choose which devices (group) → shape the data (policy) → send data somewhere (connector) → see it in Data flow. Each step explains why it matters and links to the real page with **Take me there**. That page shows a banner while the step is open.
- Steps are worked out from the current state, not ticked off, so a new admin carries on from whatever someone else already did.

## Model

- A connected device sends nothing except **update traffic** with the Canonical Snap Store. This is the one default connector (scope: All devices). It can be replaced with your own store but not removed.
- A **group** is a query, for example RAM at least 32 GB. It is saved as **dynamic** (these devices and any that match later) or **static** (exactly these devices, never dropped). A group sends nothing on its own. Groups are shared with Landscape.
- A **policy** shapes data: sampling, dropping debug logs, keeping metrics only, redacting personal data. It has a purpose (analytic, debug, regulatory) and a preview of the data before and after.
- A **connector** joins a group, a policy and a destination. This is where data leaves, so this is where the preview is. A device in several connectors' groups sends each packet to every destination.
- A **destination** has a receiver classification (internal, subsidiary, partner, external) and a region. The Destinations page is the audit view: share of data leaving devices, connectors, devices in scope and health.
- **No approvals in the MVP.** A connector is live as soon as it is created. Other admins are notified, and every change is logged in Recent changes.

## Data flow

Data flow is drawn from the onboarding state with the Insights prototype's `sankey.js`: group (or device, for 15 devices or fewer) → policy → destination. Widths are volume. Update traffic is orange, your data is blue-grey, and data dropped by shaping is grey. After the first connector, its path is highlighted. Click a node to trace its path.

`insights/` is a copy of the full Insights prototype (demo data) with this app's menu, linked from Data flow.

## Files

- `index.html`: app shell
- `js/onboarding.js`: everything specific to onboarding (state, routes, pages)
- `css/onboarding.css`: styles added on top of `css/app.css`
- `js/data.js`, `js/sankey.js`, `css/app.css`: copied unchanged from the Insights prototype
