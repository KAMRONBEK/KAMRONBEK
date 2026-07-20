import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

/*
 * Renders data/trace.json into two committed SVGs.
 *
 * Every constraint below is load-bearing, and each one was verified against how
 * GitHub actually serves README images rather than assumed:
 *
 *   - CSS @keyframes in an inline <style>. SMIL with a delay has no equivalent
 *     of animation-fill-mode: backwards, so a delayed SMIL element renders at
 *     its authored value, then snaps. CSS does not have that problem.
 *   - Animate opacity and transform only. Firefox has never shipped x/y/width/
 *     height as CSS properties, so animating those renders frozen there.
 *   - The settled state is the DEFAULT state. Animation only hides things on
 *     the way in. A renderer that ignores animation, a reader arriving mid-
 *     scroll, and prefers-reduced-motion all get the finished, legible frame.
 *   - Everything lands within ~2.8s. A profile gets a 30-90 second scan; a
 *     payoff at 9s is a payoff nobody sees.
 *   - No webfonts (CSP blocks them, and data: URIs are blocked from raw), so
 *     no glyph wider than ASCII is trusted and every text node is placed at an
 *     absolute x. Status marks are drawn as paths — a path cannot become tofu.
 *   - Theme is two files chosen by <picture> in the README, never a media query
 *     inside the SVG, which is broken in the GitHub iOS app.
 */

const W = 720;
const H = 540;

// Straight from assets/hero.svg, so the profile reads as one identity.
const THEMES = {
  dark: {
    bg: "#070a12",
    chrome: "#0e1524",
    fg: "#e9eef7",
    muted: "#8a94a8",
    accent: "#ff8f3a",
    stroke: "#1b2436",
    danger: "#ff5f56",
  },
  light: {
    bg: "#ffffff",
    chrome: "#f3f4f6",
    fg: "#1f2328",
    muted: "#59636e",
    accent: "#b8500f",
    stroke: "#d1d9e0",
    danger: "#cf222e",
  },
};

const FONT = `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace`;

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function secs(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

/*
 * Footer capacity. The footer is laid out at a fixed x with no wrapping, and
 * the CI path is LONGER than the local one (it appends a run number and a SHA),
 * so the variant that overflows is exactly the variant that ships. 13px
 * monospace advances ~7.8px, against 664px of usable width.
 */
const FOOT_MAX_CHARS = 84;

function fit(text) {
  if (text.length <= FOOT_MAX_CHARS) return text;
  console.warn(`footer clipped at ${FOOT_MAX_CHARS} chars (was ${text.length}): ${text}`);
  return `${text.slice(0, FOOT_MAX_CHARS - 3)}...`;
}

/**
 * Which events reach the graphic.
 *
 * The full trace is 27 events and most of them are the same retry told three
 * ways. The rules are mechanical and stated here so the selection is auditable
 * against data/trace.json rather than being a matter of taste:
 *
 *   - a resend is dropped; the "retry in Ns" line already tells that beat
 *   - a failure reading "offline" is dropped for the same reason; a failure
 *     with a real cause ("connection lost", "no ack") is always kept
 *   - an enqueue is kept only when it lands behind an existing backlog
 *     (`queued > 1`), which is the interesting case: accepted with no network
 *     to send it over. An enqueue that is attempted immediately says nothing
 *     the following `send` line does not already say
 *   - intermediate "settled" lines are dropped; the final one becomes the
 *     summary row, whose numbers come from trace.summary
 */
function selectRows(trace) {
  const events = trace.events;
  const rows = [];

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.kind === "settled") continue;
    if (e.kind === "sent" && e.text.startsWith("resend")) continue;
    if (e.kind === "send-failed" && e.text === "offline") continue;
    if (e.kind === "enqueued" && e.queued <= 1) continue;
    rows.push({ t: e.t, kind: e.kind, text: e.text });
  }

  const s = trace.summary;
  rows.push({
    t: s.durationMs,
    kind: "summary",
    text: `${s.lost} lost · ${s.duplicates} duplicates · in order`,
  });

  return rows;
}

/** Status marks as geometry. Colour and shape carry the meaning, not a codepoint. */
function mark(kind, x, y, p) {
  const g = (body, extra = "") => `<g transform="translate(${x} ${y})"${extra}>${body}</g>`;

  switch (kind) {
    case "connected":
      return g(`<circle r="4.5" fill="${p.accent}"/>`);
    case "disconnected":
      return g(
        `<path d="M -4.5 -4.5 L 4.5 4.5 M 4.5 -4.5 L -4.5 4.5" stroke="${p.danger}" stroke-width="2.2" stroke-linecap="round" fill="none"/>`,
      );
    case "send-failed":
      return g(`<circle r="4.5" fill="none" stroke="${p.danger}" stroke-width="2"/>`);
    case "sent":
      return g(
        `<path d="M -5 0 L 4 0 M 0.5 -3.5 L 4 0 L 0.5 3.5" stroke="${p.muted}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
      );
    case "ack":
      // Double tick: the server has it durably, not merely "sent".
      return g(
        `<path d="M -6 0.5 L -3 3.5 L 2 -3.5" stroke="${p.accent}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>` +
          `<path d="M 1 0.5 L 4 3.5 L 9 -3.5" stroke="${p.accent}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
      );
    case "retry-scheduled":
      // Three-quarter arc with a head: waiting, not stuck.
      return g(
        `<path d="M 4.5 0 A 4.5 4.5 0 1 1 0 -4.5" stroke="${p.muted}" stroke-width="2" stroke-linecap="round" fill="none"/>` +
          `<path d="M -2.6 -4.5 L 0 -4.5 L 0 -1.9" stroke="${p.muted}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
      );
    case "flushing":
      return g(
        `<path d="M -4.5 1.5 L 0 -3 L 4.5 1.5 M -4.5 5 L 0 0.5 L 4.5 5" stroke="${p.accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
      );
    case "enqueued":
      return g(`<circle r="4" fill="none" stroke="${p.muted}" stroke-width="2"/>`);
    case "summary":
      return g(
        `<path d="M -5.5 0.5 L -2 4 L 5.5 -4" stroke="${p.accent}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
      );
    default:
      return "";
  }
}

function render(trace, palette, provenance) {
  const p = palette;
  const rows = selectRows(trace);

  // Trace time compressed into the scan budget, preserving relative pacing.
  const span = Math.max(1, trace.summary.durationMs);
  const LEAD_MS = 180;
  const WINDOW_MS = 2500;
  const delayFor = (t) => Math.round(LEAD_MS + (t / span) * WINDOW_MS);

  const delays = new Map();
  const addDelay = (ms) => {
    const key = Math.round(ms);
    delays.set(key, `d${key}`);
    return `d${key}`;
  };

  // ---- left: the phone -----------------------------------------------------
  const PHONE_X = 28;
  const PHONE_Y = 84;
  const PHONE_W = 198;
  const PHONE_H = 250;

  const bubbles = trace.messages.map((m, i) => {
    const top = PHONE_Y + 30 + i * 62;
    const label = `"${m.body}"`;
    const width = Math.max(96, label.length * 8.6 + 54);
    const right = PHONE_X + PHONE_W - 16;
    const left = right - width;
    const deliverDelay = addDelay(delayFor(m.deliveredAt ?? span));
    const queueDelay = addDelay(delayFor(m.enqueuedAt));

    return (
      `<g class="row ${queueDelay}">` +
      `<rect x="${left}" y="${top}" width="${width}" height="40" rx="12" fill="${p.chrome}" stroke="${p.stroke}"/>` +
      `<text x="${left + 14}" y="${top + 25}" class="body fg">${esc(label)}</text>` +
      // queued mark, shown only until this message is confirmed
      `<g class="qmark ${deliverDelay}">${mark("enqueued", right - 20, top + 20, p)}</g>` +
      // the double tick is the DEFAULT state: settled, delivered, confirmed
      `<g class="tick ${deliverDelay}">${mark("ack", right - 24, top + 20, p)}</g>` +
      `</g>`
    );
  });

  // What the two marks mean, so the phone reads without the log.
  const legendY = PHONE_Y + PHONE_H + 36;
  const legend =
    `<g class="row ${addDelay(LEAD_MS)}">` +
    mark("enqueued", PHONE_X + 12, legendY - 5, p) +
    `<text x="${PHONE_X + 36}" y="${legendY}" class="foot mu">queued on the phone</text>` +
    mark("ack", PHONE_X + 16, legendY + 22, p) +
    `<text x="${PHONE_X + 36}" y="${legendY + 27}" class="foot mu">confirmed by the server</text>` +
    `</g>`;

  const phone =
    `<rect x="${PHONE_X}" y="${PHONE_Y}" width="${PHONE_W}" height="${PHONE_H}" rx="24" fill="${p.chrome}" stroke="${p.stroke}" stroke-width="1.5"/>` +
    `<rect x="${PHONE_X + 10}" y="${PHONE_Y + 12}" width="${PHONE_W - 20}" height="${PHONE_H - 24}" rx="16" fill="${p.bg}" stroke="${p.stroke}"/>` +
    bubbles.join("") +
    legend;

  // ---- right: the log ------------------------------------------------------
  const LOG_X = 268;
  const TIME_X = 316; // right-aligned
  const MARK_X = 336;
  const TEXT_X = 356;
  const LOG_TOP = 92;
  const LINE_H = 22;

  const logRows = rows.map((r, i) => {
    const y = LOG_TOP + i * LINE_H;
    const cls = addDelay(delayFor(r.t));
    // Only the connection loss shouts. A second red line next to it halves the
    // impact of the beat the whole graphic is built to open on.
    const strong = r.kind === "summary" || r.kind === "disconnected";
    const fill =
      r.kind === "disconnected" ? p.danger : r.kind === "summary" ? p.accent : r.kind === "send-failed" ? p.muted : p.fg;
    const weight = strong ? ` font-weight="600"` : "";

    return (
      `<g class="row ${cls}">` +
      `<text x="${TIME_X}" y="${y}" class="body mu" text-anchor="end">${esc(secs(r.t))}</text>` +
      mark(r.kind, MARK_X, y - 5, p) +
      `<text x="${TEXT_X}" y="${y}" class="body" fill="${fill}"${weight}>${esc(r.text)}</text>` +
      `</g>`
    );
  });

  const delayRules = [...delays.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ms, cls]) => `.${cls} { animation-delay: ${ms}ms; }`)
    .join("\n    ");

  const s = trace.summary;
  const sweepLine = `${s.sweep.passed}/${s.sweep.total} fault runs green · ${s.sweep.messages} messages, ${s.lost} lost, ${s.duplicates} duplicated`;

  // Every figure in the description is interpolated. A hard-coded number here
  // would silently stop matching the trace the moment the scenario changes.
  const flushEvent = trace.events.find((e) => e.kind === "flushing");
  const flushed = flushEvent ? flushEvent.queued : 0;
  const label =
    `An offline-first message queue losing its connection mid-send, backing off, then reconnecting ` +
    `and flushing ${flushed} queued message${flushed === 1 ? "" : "s"} in order. ` +
    `${s.sent} sent, ${s.delivered} delivered, ${s.lost} lost, ${s.duplicates} duplicated. ${sweepLine}.`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}">
  <title>tunnel — what my message queue does when the network dies</title>
  <style>
    text { font-family: ${FONT}; }
    .fg { fill: ${p.fg}; }
    .mu { fill: ${p.muted}; }
    .ac { fill: ${p.accent}; }
    .h1 { font-size: 18px; font-weight: 600; }
    .body { font-size: 15px; }
    .foot { font-size: 13px; }

    /* The finished frame is the default. Animation only withholds things on the
       way in, so a non-animating renderer shows the complete, settled result. */
    .row { animation: rowIn .34s cubic-bezier(.22,.61,.36,1) backwards; }
    @keyframes rowIn {
      from { opacity: 0; transform: translateY(5px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .tick { animation: fadeIn .2s linear backwards; }
    @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
    .qmark { opacity: 0; animation: fadeOut .2s linear backwards; }
    @keyframes fadeOut { from { opacity: 1 } to { opacity: 0 } }

    ${delayRules}

    @media (prefers-reduced-motion: reduce) {
      .row, .tick, .qmark { animation: none; }
      .qmark { opacity: 0; }
    }
  </style>

  <rect width="${W}" height="${H}" rx="14" fill="${p.bg}"/>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" fill="none" stroke="${p.stroke}"/>

  <text x="28" y="44" class="h1 ac">tunnel</text>
  <text x="102" y="44" class="h1 fg">what my message queue does when the network dies</text>
  <text x="28" y="68" class="body mu">an offline-first outbox, run against an adversarial network</text>

  ${phone}
  ${logRows.join("\n  ")}

  <text x="28" y="${H - 42}" class="foot mu">${esc(fit(sweepLine))}</text>
  <text x="28" y="${H - 22}" class="foot mu">${esc(fit(provenance))}</text>
</svg>
`;
}

function main() {
  const trace = JSON.parse(readFileSync(join(REPO, "data", "trace.json"), "utf8"));

  // Deliberately NOT stamped with a run number. The source commit is the thing
  // worth identifying, and keying on it instead means the same commit always
  // renders the same bytes — so a re-run commits nothing, and the file is a
  // reproducible function of the code that produced it.
  const sha = (process.env.GITHUB_SHA ?? "").slice(0, 7);
  const provenance = `rendered by tools/render-tunnel.mjs · seed ${trace.seed} · ${sha || "local"}`;

  mkdirSync(join(REPO, "assets"), { recursive: true });
  for (const [name, palette] of Object.entries(THEMES)) {
    const svg = render(trace, palette, provenance);
    writeFileSync(join(REPO, "assets", `tunnel-${name}.svg`), svg);
    console.log(`assets/tunnel-${name}.svg  ${(Buffer.byteLength(svg) / 1024).toFixed(1)} KB`);
  }
}

main();
