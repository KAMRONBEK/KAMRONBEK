import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

/*
 * A phone that demos itself: cold start, content loads, a tap, a push
 * transition, and back. One 9s CSS timeline, looping.
 *
 * Constraints (verified live against raw.githubusercontent.com this session —
 * the response carries `content-security-policy: default-src 'none';
 * style-src 'unsafe-inline'; sandbox`):
 *   - inline <style> + @keyframes only. No script, no external refs, no
 *     data: URIs, no webfonts.
 *   - opacity / transform / stroke-dashoffset only. Firefox has never shipped
 *     x/y/width/height as animatable CSS properties.
 *   - every element shares ONE duration and expresses its own beats as
 *     percentages of it, so nothing can drift out of sync.
 *   - theme is two files chosen by <picture> in the README.
 */

const W = 760;
const H = 460;
const TL = "9s"; // master timeline; every keyframe below is a % of this

const THEMES = {
  dark: {
    bg: "#070a12",
    chrome: "#0e1524",
    screen: "#0b1220",
    fg: "#e9eef7",
    muted: "#8a94a8",
    accent: "#ff8f3a",
    stroke: "#1b2436",
    skeleton: "#162034",
  },
  light: {
    bg: "#ffffff",
    chrome: "#eef1f6",
    screen: "#ffffff",
    fg: "#1f2328",
    muted: "#59636e",
    accent: "#b8500f",
    stroke: "#d1d9e0",
    skeleton: "#e6eaf0",
  },
};

// Real shipped apps, with icon hues that read as app icons rather than as chart
// colours. Kept distinct in both themes.
const APPS = [
  { name: "Netevia", sub: "banking", hue: "#3b82f6" },
  { name: "WorkAxle", sub: "workforce", hue: "#8b5cf6" },
  { name: "Swish", sub: "sports & social", hue: "#f59e0b" },
  { name: "DriveMe", sub: "chauffeur", hue: "#10b981" },
];

const FONT = `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace`;
const SANS = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function render(p) {
  const PX = 48; // phone x
  const PY = 42; // phone y
  const PW = 232;
  const PH = 376;
  const SX = PX + 12;
  const SY = PY + 14;
  const SW = PW - 24;
  const SH = PH - 28;

  // ---- screen 1: the app list -------------------------------------------
  const rows = APPS.map((a, i) => {
    const y = SY + 74 + i * 58;
    return `
      <g class="row r${i}">
        <rect x="${SX + 12}" y="${y}" width="${SW - 24}" height="46" rx="12" fill="${p.chrome}"/>
        <rect x="${SX + 20}" y="${y + 7}" width="32" height="32" rx="9" fill="${a.hue}"/>
        <text x="${SX + 62}" y="${y + 21}" class="rowName">${esc(a.name)}</text>
        <text x="${SX + 62}" y="${y + 36}" class="rowSub">${esc(a.sub)}</text>
      </g>`;
  }).join("");

  const skeletons = APPS.map((a, i) => {
    const y = SY + 74 + i * 58;
    return `
      <g class="skel s${i}">
        <rect x="${SX + 12}" y="${y}" width="${SW - 24}" height="46" rx="12" fill="${p.chrome}"/>
        <rect x="${SX + 20}" y="${y + 7}" width="32" height="32" rx="9" fill="${p.skeleton}"/>
        <rect x="${SX + 62}" y="${y + 13}" width="74" height="9" rx="4" fill="${p.skeleton}"/>
        <rect x="${SX + 62}" y="${y + 28}" width="46" height="8" rx="4" fill="${p.skeleton}"/>
      </g>`;
  }).join("");

  // ---- screen 2: the detail view ----------------------------------------
  const bars = [58, 92, 74, 116, 88].map((h, i) => {
    const x = SX + 28 + i * 34;
    return `<rect class="bar b${i}" x="${x}" y="${SY + 250 - h}" width="20" height="${h}" rx="5" fill="${p.accent}" style="transform-origin:${x + 10}px ${SY + 250}px"/>`;
  }).join("");

  const detail = `
    <g class="detail">
      <rect x="${SX}" y="${SY}" width="${SW}" height="${SH}" fill="${p.screen}"/>
      <path d="M ${SX + 26} ${SY + 36} L ${SX + 20} ${SY + 41} L ${SX + 26} ${SY + 46}" stroke="${p.accent}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="${SX + 34}" y="${SY + 46}" class="backLink">Apps</text>
      <rect x="${SX + 20}" y="${SY + 64}" width="48" height="48" rx="13" fill="${APPS[1].hue}"/>
      <text x="${SX + 78}" y="${SY + 86}" class="dTitle">WorkAxle</text>
      <text x="${SX + 78}" y="${SY + 104}" class="rowSub">live scheduling</text>
      <text x="${SX + 20}" y="${SY + 146}" class="rowSub">shifts this week</text>
      ${bars}
      <rect x="${SX + 20}" y="${SY + 274}" width="${SW - 40}" height="40" rx="12" fill="${p.accent}"/>
      <text x="${SX + SW / 2}" y="${SY + 299}" class="cta" text-anchor="middle">Open shift board</text>
    </g>`;

  // ---- right column ------------------------------------------------------
  const chips = ["React Native", "Expo", "TypeScript", "GraphQL"].map((t, i) => {
    const x = 330 + (i % 2) * 152;
    const y = 300 + Math.floor(i / 2) * 44;
    return `
      <g class="chip c${i}">
        <rect x="${x}" y="${y}" width="140" height="32" rx="16" fill="${p.chrome}" stroke="${p.stroke}"/>
        <text x="${x + 70}" y="${y + 21}" class="chipText" text-anchor="middle">${esc(t)}</text>
      </g>`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Kamronbek Juraev, React Native and Expo engineer. An animated phone cold-starting an app, loading a list of shipped apps — Netevia, WorkAxle, Swish, DriveMe — and opening one of them.">
  <title>Kamronbek Juraev — React Native / Expo engineer</title>
  <defs>
    <clipPath id="screen"><rect x="${SX}" y="${SY}" width="${SW}" height="${SH}" rx="20"/></clipPath>
  </defs>
  <style>
    text { font-family: ${SANS}; }
    .mono { font-family: ${FONT}; }

    .name    { font-size: 30px; font-weight: 700; fill: ${p.fg}; }
    .role    { font-size: 17px; fill: ${p.accent}; font-weight: 600; }
    .blurb   { font-size: 15px; fill: ${p.muted}; }
    .rowName { font-size: 14px; font-weight: 600; fill: ${p.fg}; }
    .rowSub  { font-size: 11px; fill: ${p.muted}; }
    .dTitle  { font-size: 17px; font-weight: 700; fill: ${p.fg}; }
    .backLink{ font-size: 13px; fill: ${p.accent}; font-weight: 600; }
    .cta     { font-size: 13px; font-weight: 700; fill: ${p.bg}; }
    .chipText{ font-size: 12px; fill: ${p.muted}; font-family: ${FONT}; }
    .hdr     { font-size: 16px; font-weight: 700; fill: ${p.fg}; }

    /* One duration for everything, so nothing can drift out of sync. */
    .splash, .skel, .detail, .ripple, .bar, .listGroup { animation-duration: ${TL}; animation-iteration-count: infinite; animation-timing-function: linear; }

    /* 0-7% icon springs in, holds, then hands off to the list at ~15% */
    .splash { animation-name: splash; transform-origin: ${SX + SW / 2}px ${SY + SH / 2}px; }
    @keyframes splash {
      0%   { opacity: 0; transform: scale(.4); }
      7%   { opacity: 1; transform: scale(1); }
      13%  { opacity: 1; transform: scale(1); }
      17%  { opacity: 0; transform: scale(1.25); }
      100% { opacity: 0; transform: scale(1.25); }
    }

    /* skeletons cover the gap between splash and real content */
    .skel { animation-name: skel; }
    @keyframes skel {
      0%, 14%   { opacity: 0; }
      16%, 24%  { opacity: 1; }
      28%, 100% { opacity: 0; }
    }
    .s0 { animation-delay: 0s; }
    .s1 { animation-delay: .06s; }
    .s2 { animation-delay: .12s; }
    .s3 { animation-delay: .18s; }

    /* Real rows slide up into place, one after another.
       Written as the animation shorthand rather than longhands: the stagger
       is baked into each row's own keyframes instead of an animation-delay, so
       nothing depends on how delay and duration cascade together. */
    @keyframes rowIn0 { 0%,25% { opacity:0; transform:translateY(10px); } 30%,92% { opacity:1; transform:none; } 100% { opacity:0; transform:translateY(10px); } }
    @keyframes rowIn1 { 0%,27% { opacity:0; transform:translateY(10px); } 32%,92% { opacity:1; transform:none; } 100% { opacity:0; transform:translateY(10px); } }
    @keyframes rowIn2 { 0%,29% { opacity:0; transform:translateY(10px); } 34%,92% { opacity:1; transform:none; } 100% { opacity:0; transform:translateY(10px); } }
    @keyframes rowIn3 { 0%,31% { opacity:0; transform:translateY(10px); } 36%,92% { opacity:1; transform:none; } 100% { opacity:0; transform:translateY(10px); } }
    .r0 { animation: rowIn0 ${TL} linear infinite; }
    .r1 { animation: rowIn1 ${TL} linear infinite; }
    .r2 { animation: rowIn2 ${TL} linear infinite; }
    .r3 { animation: rowIn3 ${TL} linear infinite; }

    /* the whole list slides out left as the detail pushes in */
    .listGroup { animation-name: pushOut; }
    @keyframes pushOut {
      0%, 52%  { transform: translateX(0); opacity: 1; }
      60%      { transform: translateX(-70px); opacity: 0; }
      86%      { transform: translateX(-70px); opacity: 0; }
      93%,100% { transform: translateX(0); opacity: 1; }
    }

    /* a tap on the second row, just before the push */
    .ripple { animation-name: ripple; transform-origin: ${SX + SW / 2}px ${SY + 155}px; }
    @keyframes ripple {
      0%, 45%  { opacity: 0; transform: scale(.2); }
      47%      { opacity: .55; transform: scale(.2); }
      53%      { opacity: 0; transform: scale(1.9); }
      100%     { opacity: 0; transform: scale(1.9); }
    }

    /* detail slides in from the right, iOS push style */
    .detail { animation-name: pushIn; }
    @keyframes pushIn {
      0%, 52%  { transform: translateX(240px); }
      60%      { transform: translateX(0); }
      86%      { transform: translateX(0); }
      93%,100% { transform: translateX(240px); }
    }

    /* bars grow once the detail has landed */
    .bar { animation-name: grow; }
    @keyframes grow {
      0%, 61%  { transform: scaleY(0); }
      70%      { transform: scaleY(1); }
      86%      { transform: scaleY(1); }
      90%,100% { transform: scaleY(0); }
    }
    .b0 { animation-delay: 0s; }
    .b1 { animation-delay: .07s; }
    .b2 { animation-delay: .14s; }
    .b3 { animation-delay: .21s; }
    .b4 { animation-delay: .28s; }

    .chip { animation: chipIn .6s cubic-bezier(.34,1.56,.64,1) backwards; }
    @keyframes chipIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
    .c0 { animation-delay: .5s; } .c1 { animation-delay: .6s; }
    .c2 { animation-delay: .7s; } .c3 { animation-delay: .8s; }

    .intro { animation: introIn .7s cubic-bezier(.22,.61,.36,1) backwards; }
    @keyframes introIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
    .i1 { animation-delay: .05s; } .i2 { animation-delay: .18s; } .i3 { animation-delay: .3s; }

    /* Motion is the whole point here, but it must not be the only way in:
       with motion reduced the phone settles on the loaded list. */
    @media (prefers-reduced-motion: reduce) {
      .splash, .skel, .ripple, .detail { display: none; }
      .row, .bar, .listGroup, .chip, .intro { animation: none; opacity: 1; transform: none; }
    }
  </style>

  <rect width="${W}" height="${H}" rx="16" fill="${p.bg}"/>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="16" fill="none" stroke="${p.stroke}"/>

  <!-- phone -->
  <rect x="${PX}" y="${PY}" width="${PW}" height="${PH}" rx="34" fill="${p.chrome}" stroke="${p.stroke}" stroke-width="1.5"/>
  <rect x="${SX}" y="${SY}" width="${SW}" height="${SH}" rx="20" fill="${p.screen}"/>
  <rect x="${PX + PW / 2 - 26}" y="${PY + 20}" width="52" height="6" rx="3" fill="${p.stroke}"/>

  <g clip-path="url(#screen)">
    <g class="listGroup">
      <text x="${SX + 20}" y="${SY + 52}" class="hdr">Shipped</text>
      ${skeletons}
      ${rows}
      <circle class="ripple" cx="${SX + SW / 2}" cy="${SY + 155}" r="52" fill="${p.accent}"/>
    </g>
    ${detail}
    <g class="splash">
      <rect x="${SX + SW / 2 - 34}" y="${SY + SH / 2 - 46}" width="68" height="68" rx="19" fill="${p.accent}"/>
      <text x="${SX + SW / 2}" y="${SY + SH / 2 - 2}" text-anchor="middle" font-size="34" font-weight="700" fill="${p.bg}">K</text>
      <text x="${SX + SW / 2}" y="${SY + SH / 2 + 48}" text-anchor="middle" class="rowSub">loading...</text>
    </g>
  </g>

  <!-- right column -->
  <text x="330" y="${PY + 78}" class="name intro i1">Kamronbek Juraev</text>
  <text x="330" y="${PY + 110}" class="role intro i2">React Native / Expo engineer</text>
  <text x="330" y="${PY + 156}" class="blurb intro i3">7 years building mobile apps end-to-end —</text>
  <text x="330" y="${PY + 180}" class="blurb intro i3">architecture through App Store release.</text>
  <text x="330" y="${PY + 216}" class="blurb intro i3">20+ apps shipped. Banking, logistics,</text>
  <text x="330" y="${PY + 240}" class="blurb intro i3">enterprise scheduling, social.</text>
  ${chips}
</svg>
`;
}

mkdirSync(join(REPO, "assets"), { recursive: true });
for (const [name, palette] of Object.entries(THEMES)) {
  const svg = render(palette);
  writeFileSync(join(REPO, "assets", `showcase-${name}.svg`), svg);
  console.log(`assets/showcase-${name}.svg  ${(Buffer.byteLength(svg) / 1024).toFixed(1)} KB`);
}
