# AARIS Design Language

> A reusable web design guide for my projects, based on the visual language of `aaris.tech`.

## 1. Purpose

My web projects should feel consistent even when they solve different problems.

The design should feel like an operator console, a technical dossier, and a clean infrastructure dashboard. It should be dark, sharp, calm, and practical. It should look like it belongs to someone who works with datacenters, networking, Linux, backups, homelab systems, and self-hosted tools.

This is not a generic startup SaaS style. It should feel technical, personal, and slightly industrial.

## 2. Core feeling

Use these words as the north star:

- **Technical**
- **Dark**
- **Sharp**
- **Readable**
- **Infrastructure-focused**
- **Self-hosted**
- **Operator-first**
- **Low-noise**
- **Confident**
- **A little playful, but not childish**

The design should feel like a mix of:

- Network operations center
- Server rack labels
- Datacenter asset tags
- CLI output
- Technical documentation
- Homelab dashboard
- Industrial control panel

## 3. Design principles

### 3.1 Dark by default

All projects should be dark-first. The background should be close to black, but not pure black. Use raised panels for separation instead of bright backgrounds.

The interface should feel good in a dark Homarr-style environment.

### 3.2 Thin borders over heavy shadows

Use borders, lines, separators, grids, and panels instead of soft shadows.

Avoid rounded, floating, bubbly UI. The style should be structured and engineered.

### 3.3 Orange is the action color

Orange is the main accent color. Use it for active navigation, primary buttons, highlights, important section numbers, hover states, and key technical markers.

Do not overuse orange. It should feel like a signal light, not decoration.

### 3.4 Mono labels, strong headings

Use a strong condensed or wide sans-serif for headings and a monospace font for labels, metadata, navigation, tags, counters, timestamps, and technical values.

Headings should feel bold and uppercase. Metadata should feel like machine-readable labels.

### 3.5 Content should be structured like a system

Prefer layouts that feel like:

- Status bars
- Asset plates
- Capability matrices
- Rack units
- Log rows
- Tables
- Tags
- Cards with headers
- Section numbers
- Protocol labels
- Dossier pages

The design should make content feel organized and operational.

### 3.6 Motion should communicate status

Use motion sparingly.

Good motion:

- Progress indicator while scrolling
- Blinking LED status indicators
- Subtle hover movement
- Slow ticker for repeated technical tags
- Reveal animation when content enters view

Bad motion:

- Bouncy animations
- Overly playful transitions
- Large parallax effects
- Constant distractions

Always support `prefers-reduced-motion`.

## 4. Color system

Use this palette as the default token set.

```css
:root {
  --bg: #0e1014;
  --bg-raise: #12151a;

  --ink: #e9ecef;
  --muted: #8b939e;
  --dim: #4d545e;

  --line: #232830;
  --line-soft: #1a1e25;

  --accent: #ff5a1f;
  --ok: #3fd97f;
  --warning: #ffb224;
}
```

### Usage

| Token | Use |
|---|---|
| `--bg` | Main page background |
| `--bg-raise` | Cards, panels, raised sections |
| `--ink` | Main text and important values |
| `--muted` | Secondary text, descriptions, inactive nav |
| `--dim` | Low-priority metadata, counters, disabled labels |
| `--line` | Main borders |
| `--line-soft` | Internal dividers and background grid |
| `--accent` | Primary actions, active states, section numbers |
| `--ok` | Healthy status LEDs |
| `--warning` | Activity LEDs and warnings |

### Rules

- Do not use pure white.
- Do not use pure black.
- Do not add many accent colors.
- Keep orange as the main brand/action color.
- Green and amber are only for status.
- Keep the overall contrast readable but not harsh.

## 5. Typography

### Preferred fonts

```css
:root {
  --font-sans: "Archivo", system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
```

### Headings

Headings should be:

- Uppercase
- Heavy weight
- Slightly condensed or expanded
- Tight line-height
- Strong and technical

Example:

```css
.display {
  font-family: var(--font-sans);
  font-weight: 900;
  font-stretch: 125%;
  text-transform: uppercase;
  letter-spacing: -0.01em;
}
```

### Metadata and labels

Use monospace for:

- Navigation numbers
- Section numbers
- Status text
- Protocol names
- Tags
- Timestamps
- Technical values
- Small labels
- Buttons

Example:

```css
.meta {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}
```

## 6. Layout system

### Page width

Use a centered layout with a maximum width around `1200px`.

```css
.sheet {
  max-width: 1200px;
  margin: 0 auto;
  padding: 96px 24px;
}
```

### Background grid

A subtle technical grid helps connect all pages visually.

```css
body::before {
  content: "";
  position: fixed;
  inset: 0;
  z-index: -1; /* behind content — a fixed element at z-index auto/0 paints over non-positioned elements */
  pointer-events: none;
  background-image:
    linear-gradient(var(--line-soft) 1px, transparent 1px),
    linear-gradient(90deg, var(--line-soft) 1px, transparent 1px);
  background-size: 48px 48px;
  opacity: 0.55;
}
```

### Sections

Sections should use:

- Section number
- Big uppercase title
- Optional metadata
- Thin horizontal rule
- Content below

Example structure:

```md
01 / OPERATOR
TECHNICAL DOSSIER
HUMAN, MOSTLY SELF-HOSTING
```

### Spacing

Use generous section spacing and compact internal spacing.

Good values:

- Page horizontal padding: `24px`
- Section vertical padding: `72px` to `96px`
- Card padding: `16px` to `24px`
- Small internal gaps: `8px` to `14px`
- Grid size: `48px`

## 7. Components

### 7.1 Status bar

Use a fixed top status/navigation bar on apps and dashboards.

It should include:

- Wordmark or project name
- Numbered navigation items
- Optional clock/status
- Thin progress line
- Active item highlighted in orange

Style:

- Height around `52px`
- Dark translucent background
- Blur is allowed, but keep it subtle
- Bottom border with `--line`

### 7.2 Buttons

Buttons should feel like terminal actions.

Rules:

- Square corners
- Thin border
- Monospace text
- Uppercase
- Letter spacing
- Arrow or protocol-like indicator is allowed
- Orange fill for primary action

Example:

```css
.btn {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  padding: 15px 24px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.btn:hover {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--bg);
}
```

### 7.3 Plates

Use plates for key/value information, like asset tags or system information.

A plate should have:

- Thin border
- Raised background
- Header row
- Key/value rows
- Monospace labels
- Optional barcode-style decoration

Good for:

- User profile details
- Server facts
- Service status
- Project metadata
- Version info
- Contact information

### 7.4 Capability matrix

Use a matrix layout for skills, features, services, or supported technologies.

Pattern:

```md
BACKUP & RESTORE
HYCU R-Cloud / Proxmox Backup Server / Datto Siris / Offsite S3 backup
```

Rules:

- Category label in orange
- Items in muted text
- Important terms in brighter text
- Thin row separators

### 7.5 Cells/cards

Cards should feel like grid cells, not floating boxes.

Rules:

- Border on all sides
- No large border radius
- No heavy shadow
- Optional index in top-right corner
- Hover can slightly raise contrast
- Icons should be grayscale by default and full color on hover

### 7.6 Tags

Tags should be small, bordered, uppercase, and monospace.

Use them for technology names, status labels, categories, and protocols.

Example:

```md
NUTANIX
FORTIGATE
HYCU
TRUENAS
DOCKER
```

### 7.7 Rack metaphor

For infrastructure or homelab pages, use a rack-style component.

Good uses:

- Showing services by layer
- Explaining architecture
- Displaying hardware
- Grouping systems by function

Rules:

- Use unit labels like `U07`, `U05`, `U03-02`
- Add small LED states
- Keep descriptions practical
- Use tags for the stack

### 7.8 Uplink/contact rows

For contact, external links, APIs, or integrations, use protocol-style rows.

Example labels:

- `SMTP / 587`
- `HTTPS / 443`
- `SSH / 22`
- `API / JSON`
- `DOCS / MD`

Hover state can turn the whole row orange.

## 8. Icon and visual style

Use icons sparingly.

Preferred visual elements:

- LEDs
- Arrows
- Protocol labels
- Barcodes
- Grid lines
- Rack screws
- Tiny counters
- Section numbers
- Status text
- CLI-inspired labels

Avoid:

- Big colorful illustrations
- Blob shapes
- Gradient-heavy backgrounds
- Cartoon icons
- Excessive glassmorphism
- Rounded SaaS cards
- Emoji as core UI

Emoji can be used in writing, but not as the foundation of the interface.

## 9. Border and radius rules

The default style should use **no border radius** or very small radius only when needed.

Preferred:

```css
border: 1px solid var(--line);
border-radius: 0;
```

Avoid:

```css
border-radius: 16px;
box-shadow: 0 20px 60px rgba(0,0,0,.4);
```

The design should feel machined, not soft.

## 10. Interaction rules

### Hover

Hover states should be immediate and simple.

Good hover effects:

- Text changes from muted to ink
- Border changes to orange
- Background changes to raised dark
- Entire action row turns orange
- Arrow moves slightly
- Rack unit slides slightly

### Active state

Active state should use orange.

Examples:

- Active nav link
- Active filter
- Selected tab
- Current section
- Primary action

### Status LEDs

Use tiny square LEDs.

```css
.led {
  width: 8px;
  height: 8px;
  display: inline-block;
}

.led-ok {
  background: var(--ok);
}

.led-act {
  background: var(--warning);
}

.led-off {
  background: var(--line);
}
```

## 11. Writing style

The writing should sound like a technical person, not a marketing department.

### Voice

- Direct
- Practical
- Slightly dry humor is okay
- Confident but not arrogant
- Human but still technical

### Good phrases

- `Operational`
- `Current state`
- `Service history`
- `Capability matrix`
- `Inspection`
- `Uplink`
- `Packet loss 0%`
- `No cookies, no tracking, no telemetry`
- `Served from Rack-01`
- `Future bad decisions`
- `Human, mostly self-hosting`

### Avoid

- “Unlock your potential”
- “Seamless digital experiences”
- “Next-generation platform”
- “Beautifully crafted solutions”
- Generic startup language
- Overly polished corporate filler

### Tone example

Bad:

> We create innovative digital solutions that empower users.

Good:

> Small self-hosted tool for converting files without sending them to a random cloud service.

Bad:

> Contact me to explore synergies.

Good:

> Professional opportunity, collaboration, or just talking tech — all packets accepted.

## 12. Page structure pattern

Most projects should follow this structure:

```md
STATUS BAR
Project name / numbered nav / status

01 / OVERVIEW
What this is, who it is for, and why it exists.

02 / CAPABILITY MATRIX
Main features, technologies, or modules.

03 / SYSTEM DETAILS
Architecture, stack, hosting, data flow, or implementation notes.

04 / INTERFACE
Screenshots, examples, demo, or usage.

05 / UPLINK
Contact, repo, docs, live link, API, or download.
```

Small tools can use fewer sections, but should still keep the same visual DNA.

## 13. Project types

### Portfolio / personal site

Use the full dossier style:

- Big identity header
- Technical profile plate
- Capability matrix
- Service history
- Certifications
- Rack/homelab section
- Uplink/contact rows

### Web tools

Use a more compact app-console style:

- Fixed status bar
- Tool title
- Short technical description
- Input/output panels
- Clear primary action
- Small privacy/status note
- No unnecessary marketing

### Dashboards

Use the strongest ops language:

- Status LEDs
- Panels
- Metrics
- Logs
- Filters
- Timestamps
- Monospace labels
- Orange only for active/important states

### Documentation sites

Use a cleaner version:

- Dark theme
- Thin borders
- Strong section headers
- Code blocks
- Tags
- Clear navigation
- Less animation

## 14. Accessibility rules

Even though the style is technical, it must still be usable.

Rules:

- Keep text contrast high enough.
- Do not rely on color alone for status.
- Use visible focus states.
- Respect `prefers-reduced-motion`.
- Keep font sizes readable.
- Make mobile layouts single-column where needed.
- Ensure buttons and links have large enough click areas.
- Do not hide important text behind hover-only interactions.

## 15. Reusable CSS starter

```css
:root {
  --bg: #0e1014;
  --bg-raise: #12151a;
  --ink: #e9ecef;
  --muted: #8b939e;
  --dim: #4d545e;
  --line: #232830;
  --line-soft: #1a1e25;
  --accent: #ff5a1f;
  --ok: #3fd97f;
  --warning: #ffb224;

  --font-sans: "Archivo", system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

* {
  box-sizing: border-box;
}

html {
  scroll-behavior: smooth;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--font-sans);
  -webkit-font-smoothing: antialiased;
}

body::before {
  content: "";
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background-image:
    linear-gradient(var(--line-soft) 1px, transparent 1px),
    linear-gradient(90deg, var(--line-soft) 1px, transparent 1px);
  background-size: 48px 48px;
  opacity: 0.55;
}

::selection {
  background: var(--accent);
  color: var(--bg);
}

a {
  color: inherit;
}

.sheet {
  position: relative;
  max-width: 1200px;
  margin: 0 auto;
  padding: 96px 24px;
}

.display {
  font-family: var(--font-sans);
  font-weight: 900;
  font-stretch: 125%;
  text-transform: uppercase;
  letter-spacing: -0.01em;
}

.mono {
  font-family: var(--font-mono);
}

.section-head {
  display: flex;
  align-items: baseline;
  gap: 18px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.section-number {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 600;
  color: var(--accent);
  letter-spacing: 0.1em;
}

.section-title {
  font-family: var(--font-sans);
  font-weight: 900;
  font-stretch: 125%;
  text-transform: uppercase;
  font-size: clamp(26px, 4.5vw, 40px);
  line-height: 1;
}

.rule {
  height: 1px;
  background: var(--line);
}

.panel {
  border: 1px solid var(--line);
  background: var(--bg-raise);
}

.tag {
  display: inline-block;
  padding: 3px 9px;
  border: 1px solid var(--line);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.1em;
  color: var(--muted);
  text-transform: uppercase;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  padding: 15px 24px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  text-decoration: none;
}

.btn:hover {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--bg);
}

.led {
  width: 8px;
  height: 8px;
  display: inline-block;
}

.led-ok {
  background: var(--ok);
}

.led-warning {
  background: var(--warning);
}

.led-off {
  background: var(--line);
}

@media (prefers-reduced-motion: reduce) {
  html {
    scroll-behavior: auto;
  }

  * {
    animation: none !important;
    transition: none !important;
  }
}
```

## 16. Do and do not

### Do

- Use dark backgrounds.
- Use thin borders.
- Use orange as the main accent.
- Use monospace labels.
- Use uppercase technical headings.
- Use panels, grids, tags, and status rows.
- Make content feel like infrastructure documentation.
- Keep things readable and practical.
- Add small bits of personality.

### Do not

- Make it look like a generic SaaS landing page.
- Use soft pastel colors.
- Use large rounded cards.
- Use heavy shadows.
- Use random accent colors.
- Over-animate the UI.
- Fill pages with marketing language.
- Make the interface feel cute or childish.

## 17. One-sentence rule

If a page does not feel like it could belong on a self-hosted infrastructure dashboard, it is probably drifting away from the AARIS design language.
