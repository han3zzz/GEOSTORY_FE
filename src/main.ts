/**
 *
 * Wallet: Petra / AIP-62 · MetaMask (EVM) · Demo
 *   → Used only for identity verification (getting wallet address)
 *   → Does NOT sign upload transactions — server handles everything
 *
 * Storage: server uploads to Shelby dev account
 *   → All blobs stored under one address (SHELBY_ACCOUNT_ADDRESS)
 *   → author field = actual wallet address of the user
 *   → Later used to tip authors directly via wallet (AIP-62 transfer)
 */

// ── Buffer polyfill ───────────────────────────────────────────────────────────
import { Buffer } from "buffer";
(window as any).Buffer = Buffer;

import { Network } from "@aptos-labs/ts-sdk";
import { getWallets } from "@wallet-standard/app";

/* ════════════════════════════════════════
   HELPERS
════════════════════════════════════════ */
const esc = (s: any): string =>
  s == null
    ? ""
    : String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");

const delay = (ms: number): Promise<void> =>
  new Promise(r => setTimeout(r, ms));

function timeAgo(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60000)    return "just now";
  if (d < 3600000)  return Math.floor(d / 60000)   + "m ago";
  if (d < 86400000) return Math.floor(d / 3600000)  + "h ago";
  return Math.floor(d / 86400000) + "d ago";
}

const CAT_EMOJI: Record<string, string> = {
  photo: "📷", adventure: "⛰", food: "🍜",
  art: "🎨", travel: "✈", nature: "🌿",
};
const MOOD_COLOR: Record<string, string> = {
  "🤩": "#ffd760", "😊": "#4dffb4", "😌": "#88ccff",
  "🤔": "#ffae5c", "😢": "#74b9ff", "🔥": "#ff6b35",
};

/* ════════════════════════════════════════
   STATE
════════════════════════════════════════ */
const S: {
  walletAddr:    string | null;
  walletType:    "petra" | "demo" | "metamask" | null;
  stories:       any[];
  markers:       any[];
  filter:        string;
  picking:       boolean;
  lat:           number | null;
  lng:           number | null;
  mood:          string;
  cat:           string;
  imgData:       string | null;
  tempMarker:    any;
  shelbyLoading: boolean;
} = {
  walletAddr:    null,
  walletType:    null,
  stories:       [],
  markers:       [],
  filter:        "all",
  picking:       false,
  lat:           null,
  lng:           null,
  mood:          "😊",
  cat:           "photo",
  imgData:       null,
  tempMarker:    null,
  shelbyLoading: false,
};
(window as any).S = S;

/* ════════════════════════════════════════
   MAP
════════════════════════════════════════ */
const L = (window as any).L;

const map = L.map("map", {
  center: [15, 100],
  zoom: 4,
  zoomControl: false,
  attributionControl: false,
  worldCopyJump: true,
  minZoom: 3,
});

L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
  maxZoom: 19,
  noWrap: false,
}).addTo(map);

L.control.zoom({ position: "topright" }).addTo(map);

/* ════════════════════════════════════════
   GLOBE
════════════════════════════════════════ */
(function setupGlobe() {
  const wrap = document.createElement("div");
  wrap.id = "globe-wrap";
  wrap.innerHTML = `
    <canvas id="globe-canvas"></canvas>
    <div id="globe-hint">DRAG TO ROTATE  ·  SCROLL UP TO ZOOM IN</div>
    <button id="globe-enter" onclick="exitGlobe()">↗ ENTER MAP</button>
  `;
  document.body.appendChild(wrap);
  (window as any)._globeWrap = wrap;
})();

const GC: {
  canvas:   HTMLCanvasElement | null;
  ctx:      CanvasRenderingContext2D | null;
  w: number; h: number; r: number;
  rotX: number; rotY: number;
  dragging: boolean;
  lastX: number; lastY: number;
  velX: number; velY: number;
  raf:    number | null;
  stars:  { x: number; y: number; r: number; a: number }[];
} = {
  canvas: null, ctx: null,
  w: 0, h: 0, r: 0,
  rotX: 0.25, rotY: 1.85,
  dragging: false,
  lastX: 0, lastY: 0,
  velX: 0, velY: 0,
  raf: null,
  stars: [],
};

function _buildStars(w: number, h: number): void {
  GC.stars = Array.from({ length: 240 }, (_, i) => ({
    x: ((i * 7919 + 13) % w),
    y: ((i * 6271 + 7)  % h),
    r: (i % 3 === 0) ? 1.2 : 0.6,
    a: 0.25 + (i % 7) * 0.11,
  }));
}

function initGlobe(): void {
  GC.canvas = document.getElementById("globe-canvas") as HTMLCanvasElement;
  GC.ctx    = GC.canvas.getContext("2d")!;
  _resizeGlobe();

  GC.canvas.addEventListener("mousedown", e => {
    GC.dragging = true; GC.lastX = e.clientX; GC.lastY = e.clientY;
    GC.velX = GC.velY = 0; e.preventDefault();
  });
  window.addEventListener("mousemove", e => {
    if (!GC.dragging) return;
    const dx = e.clientX - GC.lastX, dy = e.clientY - GC.lastY;
    GC.velY = dx * 0.005; GC.velX = dy * 0.005;
    GC.rotY += GC.velY; GC.rotX += GC.velX;
    GC.rotX = Math.max(-1.4, Math.min(1.4, GC.rotX));
    GC.lastX = e.clientX; GC.lastY = e.clientY;
  });
  window.addEventListener("mouseup", () => { GC.dragging = false; });

  GC.canvas.addEventListener("touchstart", e => {
    GC.dragging = true;
    GC.lastX = e.touches[0].clientX; GC.lastY = e.touches[0].clientY;
    GC.velX = GC.velY = 0; e.preventDefault();
  }, { passive: false });
  window.addEventListener("touchmove", e => {
    if (!GC.dragging) return;
    const dx = e.touches[0].clientX - GC.lastX, dy = e.touches[0].clientY - GC.lastY;
    GC.rotY += dx * 0.005; GC.rotX += dy * 0.005;
    GC.rotX = Math.max(-1.4, Math.min(1.4, GC.rotX));
    GC.lastX = e.touches[0].clientX; GC.lastY = e.touches[0].clientY;
  });
  window.addEventListener("touchend", () => { GC.dragging = false; });

  GC.canvas.addEventListener("wheel", e => {
    if (e.deltaY < 0) exitGlobe();
    e.preventDefault();
  }, { passive: false });

  window.addEventListener("resize", _resizeGlobe);
  _drawGlobe();
}

function _resizeGlobe(): void {
  GC.w = window.innerWidth;
  GC.h = window.innerHeight;
  GC.r = Math.min(GC.w, GC.h) * 0.40;
  GC.canvas!.width  = GC.w;
  GC.canvas!.height = GC.h;
  _buildStars(GC.w, GC.h);
}

function _project(latR: number, lngR: number): { x: number; y: number; visible: boolean } {
  const x0 = Math.cos(latR) * Math.sin(lngR);
  const y0 = Math.sin(latR);
  const z0 = Math.cos(latR) * Math.cos(lngR);
  const y1 = y0 * Math.cos(GC.rotX) - z0 * Math.sin(GC.rotX);
  const z1 = y0 * Math.sin(GC.rotX) + z0 * Math.cos(GC.rotX);
  const x2 =  x0 * Math.cos(GC.rotY) + z1 * Math.sin(GC.rotY);
  const z2 = -x0 * Math.sin(GC.rotY) + z1 * Math.cos(GC.rotY);
  return { x: x2, y: y1, visible: z2 > 0 };
}

function _drawGlobe(): void {
  if (!GC.ctx) return;
  const { ctx, w, h, r, stars } = GC;
  const cx = w / 2, cy = h / 2;
  ctx.clearRect(0, 0, w, h);

  const bgG = ctx.createRadialGradient(cx, cy, r * 0.4, cx, cy, r * 1.8);
  bgG.addColorStop(0, "#080d1a"); bgG.addColorStop(1, "#03050e");
  ctx.fillStyle = bgG; ctx.fillRect(0, 0, w, h);

  ctx.save();
  stars.forEach(s => {
    ctx.globalAlpha = s.a; ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
  });
  ctx.restore();

  const darkG = ctx.createRadialGradient(cx - r * .28, cy - r * .25, r * .08, cx, cy, r);
  darkG.addColorStop(0,   "rgba(10,20,50,0.97)");
  darkG.addColorStop(.55, "rgba(5,10,28,0.98)");
  darkG.addColorStop(1,   "rgba(2,4,10,1)");
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = darkG; ctx.fill();

  ctx.save(); ctx.strokeStyle = "rgba(77,255,180,0.04)"; ctx.lineWidth = .5;
  for (let lat = -80; lat <= 80; lat += 20) {
    const lr = lat * Math.PI / 180;
    ctx.beginPath(); let first = true;
    for (let lng = -180; lng <= 180; lng += 3) {
      const p = _project(lr, lng * Math.PI / 180);
      if (!p.visible) { first = true; continue; }
      const px = cx + p.x * r, py = cy - p.y * r;
      first ? ctx.moveTo(px, py) : ctx.lineTo(px, py); first = false;
    }
    ctx.stroke();
  }
  for (let lng = -180; lng < 180; lng += 20) {
    const lr = lng * Math.PI / 180;
    ctx.beginPath(); let first = true;
    for (let lat = -90; lat <= 90; lat += 3) {
      const p = _project(lat * Math.PI / 180, lr);
      if (!p.visible) { first = true; continue; }
      const px = cx + p.x * r, py = cy - p.y * r;
      first ? ctx.moveTo(px, py) : ctx.lineTo(px, py); first = false;
    }
    ctx.stroke();
  }
  ctx.restore();

  _drawCoastlines(ctx, cx, cy, r);

  S.stories.forEach(s => {
    const p = _project(s.lat * Math.PI / 180, s.lng * Math.PI / 180);
    if (!p.visible) return;
    const px = cx + p.x * r, py = cy - p.y * r;
    const col = MOOD_COLOR[s.mood] || "#4dffb4";
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.beginPath(); ctx.arc(px, py, 9, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 14; ctx.fill();
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.fill();
    ctx.globalAlpha = 0.7;
    ctx.beginPath(); ctx.arc(px, py, 5.5, 0, Math.PI * 2);
    ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.stroke();
    ctx.restore();
  });

  const lightG = ctx.createRadialGradient(cx - r * .4, cy - r * .38, 0, cx, cy, r);
  lightG.addColorStop(0,   "rgba(80,140,255,.07)");
  lightG.addColorStop(.5,  "rgba(77,255,180,.025)");
  lightG.addColorStop(1,   "rgba(0,0,0,0)");
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = lightG; ctx.fill();

  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(77,255,180,.22)"; ctx.lineWidth = 1.5; ctx.stroke();

  if (!GC.dragging) {
    GC.velX *= .93; GC.velY *= .93;
    GC.rotX += GC.velX; GC.rotY += GC.velY;
    GC.rotY += 0.0007;
  }
  GC.raf = requestAnimationFrame(_drawGlobe);
}

/* ════════════════════════════════════════
   VIETNAM ISLANDS
════════════════════════════════════════ */
const VN_ISLANDS = [
  { name: "Hoang Sa", lat: 16.50, lng: 111.90, note: "Hoang Sa Islands(Viet Nam)" },
  { name: "Truong Sa", lat: 10.00, lng: 114.50, note: "Truong Sa Islands(Viet Nam)" },
];

function addVietnamIslandMarkers(): void {
  VN_ISLANDS.forEach(island => {
    const icon = L.divIcon({
      className: "",
      html: `<div class="vn-island-marker" title="${island.note}">
        <div class="vn-island-flag"></div>
        <div class="vn-island-label">${island.name}</div>
      </div>`,
      iconSize: [64, 40],
      iconAnchor: [32, 20],
    });
    L.marker([island.lat, island.lng], { icon })
      .addTo(map)
      .bindPopup(`
        <div style="font-family:'IBM Plex Mono',monospace;padding:4px 2px">
          <div style="color:#4dffb4;font-size:0.75rem;font-weight:600">🇻🇳 ${island.note}</div>
          <div style="color:#5a6a8a;font-size:0.62rem;margin-top:4px">${island.lat}°N, ${island.lng}°E</div>
        </div>`, { maxWidth: 240 });
  });
}

/* ════════════════════════════════════════
   COASTLINES DATA
════════════════════════════════════════ */
const COASTLINES: number[][][] = (() => {
  const raw: number[][][] = [
    [[1.3,103.8],[1.4,104.1],[1.7,103.6],[1.3,103.8]],
    [[5.3,100.3],[5.5,100.4],[5.8,100.5],[6.0,100.3],[5.3,100.3]],
    [[10.0,104.5],[10.5,104.8],[11.0,104.7],[11.5,104.9],[12.0,104.8],[12.5,104.5],
     [13.0,104.2],[13.5,103.8],[14.0,103.5],[14.5,103.8],[15.0,104.0],[15.5,108.5],
     [16.0,108.3],[16.5,107.8],[17.0,107.2],[17.5,106.8],[18.0,106.5],[18.5,106.0],
     [19.0,105.8],[19.5,106.0],[20.0,106.3],[20.5,106.8],[21.0,107.5],[21.3,108.2],
     [20.9,107.0],[20.5,106.5],[20.0,106.1],[19.5,105.8],[19.0,105.6],[18.5,105.9],
     [17.5,106.5],[16.5,107.5],[15.9,108.4],[15.5,108.9],[14.8,109.2],[13.8,109.3],
     [12.8,109.2],[11.8,109.0],[11.0,108.5],[10.5,107.5],[10.0,104.5]],
    [[1.3,103.8],[2.0,103.9],[3.0,103.5],[4.0,103.4],[5.0,102.9],[6.0,102.2],
     [7.0,101.5],[8.0,100.5],[9.0,99.8],[10.0,99.0],[11.0,99.5],[12.0,100.1],
     [13.0,100.6],[13.7,100.5]],
    [[10.0,98.5],[11.0,98.8],[12.0,98.5],[13.0,98.2],[14.0,98.0],[15.0,97.8],
     [16.0,97.5],[17.0,97.3],[18.0,97.0],[19.0,96.8],[20.0,96.9]],
    [[20.0,110.5],[21.0,110.8],[22.0,111.5],[23.0,116.7],[24.0,117.5],
     [25.0,119.5],[26.0,119.9],[27.0,120.8],[28.0,121.5],[29.0,122.0],
     [30.0,122.3],[31.0,121.8],[32.0,121.5],[33.0,120.8],[34.0,120.3],
     [35.0,119.5],[36.0,120.5],[37.0,122.5],[38.0,121.5],[39.0,121.8],
     [40.0,122.5],[41.0,121.0]],
    [[31.5,131.0],[32.0,131.5],[33.0,132.0],[34.0,134.0],[35.0,136.8],
     [36.0,136.5],[37.0,137.0],[38.0,141.0],[39.0,141.8],[40.0,141.5],
     [41.0,141.0],[42.0,140.5],[43.0,141.4],[44.0,144.0],[43.0,145.0],
     [42.0,143.5],[41.0,140.8],[40.5,140.5]],
    [[34.5,126.0],[35.0,126.5],[35.5,129.4],[36.0,129.6],[37.0,129.4],
     [37.5,126.6],[37.0,126.2],[36.5,126.3],[35.5,126.5],[35.0,126.3]],
    [[14.5,121.0],[15.0,120.0],[16.0,119.8],[17.0,120.3],[18.0,122.0],
     [17.0,122.5],[16.0,122.3],[15.0,121.8],[14.5,121.0]],
    [[5.5,95.3],[4.5,95.6],[3.5,96.0],[2.5,96.2],[1.5,98.8],[0.5,99.5],
     [-0.5,100.3],[-1.5,100.8],[-2.5,101.5],[-3.5,102.3],[-4.5,103.5],
     [-5.5,105.5],[-5.9,105.9]],
    [[8.0,77.5],[9.0,77.5],[10.0,76.9],[11.0,75.5],[12.0,74.8],[13.0,74.8],
     [14.0,74.5],[15.0,73.9],[16.0,73.5],[17.0,73.3],[18.0,73.1],[19.0,72.8],
     [20.0,72.8],[21.0,69.2],[22.0,68.8],[23.0,68.4],[23.5,68.3],
     [22.5,70.2],[22.0,72.6],[21.0,72.4],[20.0,72.8]],
    [[8.0,77.5],[9.0,79.0],[10.0,80.3],[11.0,79.9],[12.0,80.3],[13.0,80.2],
     [14.0,80.0],[15.0,80.2],[16.0,80.3],[17.0,82.3],[18.0,84.1],[19.0,85.1],
     [20.0,86.5],[21.0,87.0],[22.0,88.0]],
    [[9.8,80.3],[8.5,81.2],[6.0,80.2],[7.5,79.9],[9.8,80.3]],
    [[37.3,10.0],[36.8,11.0],[37.0,11.2],[37.3,10.0]],
    [[35.0,-5.0],[35.5,-5.3],[36.0,-5.5],[37.0,-5.0],[37.5,-0.5],
     [37.0,4.0],[35.0,11.0],[33.0,12.5],[32.0,11.5],[31.0,10.0],
     [30.5,9.8],[31.3,9.5],[30.0,9.3]],
    [[-11.7,40.5],[-10.0,40.5],[-8.0,39.5],[-6.0,39.3],[-4.0,39.7],
     [-2.0,40.9],[0,41.5],[2,41.0],[4,41.5],[5,44.0],[8,48.0],
     [10,51.0],[11,51.5],[12,44.5],[11,43.3],[12,43.0],[11.5,42.5]],
    [[-34.8,19.9],[-34.4,26.5],[-33.0,28.0],[-31.0,30.0],[-29.0,31.0],
     [-26.0,33.0],[-24.0,35.0],[-22.0,35.5],[-20.0,35.0],[-18.0,37.0],
     [-16.0,39.5],[-14.0,40.5],[-12.0,40.5]],
    [[-34.8,19.9],[-33.0,18.0],[-31.0,17.5],[-29.0,16.8],[-27.0,15.5],
     [-25.0,15.0],[-22.0,14.3],[-19.0,12.3],[-17.0,11.8],[-15.0,12.0],
     [-13.0,12.5],[-11.0,14.0],[-10.0,16.0]],
    [[15.0,-17.5],[14.0,-17.0],[13.0,-16.5],[12.0,-15.0],[11.0,-15.0],
     [10.0,-14.0],[9.0,-13.5],[8.0,-13.0],[7.0,-11.5],[6.0,-10.0],
     [5.0,-5.0],[4.5,-2.5],[4.0,1.5],[5.0,3.0],[6.0,3.5],[4.0,8.0],
     [3.0,9.5],[2.0,9.7],[1.0,9.3],[0,2.0],[0,-1.0]],
    [[37.0,-8.5],[36.5,-7.0],[36.0,-5.5],[36.4,-4.5],[36.7,-3.5],
     [37.0,-1.5],[37.5,1.0],[37.2,4.0],[36.8,5.0],[37.0,7.5],
     [37.5,9.5],[37.3,10.5],[37.0,11.0]],
    [[31.5,32.0],[31.0,32.5],[30.5,32.3],[30.0,32.5],[29.0,34.8],
     [28.0,34.5],[27.0,34.0],[25.0,37.0],[22.5,37.2],[21.0,37.0]],
    [[36.0,-5.5],[37.0,-7.0],[38.0,-8.0],[39.0,-9.5],[40.0,-8.8],
     [41.5,-8.8],[42.0,-8.9],[43.0,-9.3],[43.5,-8.5],[44.0,-8.3],
     [43.4,-1.8],[43.0,-1.5],[42.5,-3.0],[43.0,-4.0],[43.5,-4.5],
     [43.7,-8.0]],
    [[36.0,-5.5],[36.5,-4.5],[37.0,-3.5],[38.0,-0.5],[38.5,0.5],
     [40.0,0.5],[41.0,1.5],[42.0,3.5],[43.4,4.0],[43.0,5.0],
     [43.3,5.5],[43.0,6.5],[43.7,7.5]],
    [[43.7,7.5],[44.0,8.0],[43.5,10.0],[42.5,11.0],[42.0,12.0],
     [41.0,13.5],[40.0,15.0],[39.0,16.5],[38.0,15.5],[37.5,15.0],
     [37.0,15.5],[36.5,14.5],[36.8,14.0],[37.0,13.0],[37.5,12.5],
     [38.0,13.0],[38.5,13.5],[39.0,16.5]],
    [[40.0,20.0],[41.0,19.5],[42.0,19.0],[42.5,18.5],[43.0,17.0],
     [44.0,15.5],[43.5,15.0],[44.5,14.5],[45.0,13.8],[44.8,13.5],
     [45.3,13.7]],
    [[40.0,22.5],[39.5,24.0],[39.0,23.0],[38.0,24.0],[37.0,23.5],
     [36.5,22.5],[37.0,21.5],[37.5,21.0],[37.0,22.0],[38.0,24.0]],
    [[41.0,26.5],[40.5,27.0],[40.0,26.5],[39.0,26.5],[38.0,27.2],
     [37.5,27.0],[37.0,27.5],[36.5,29.0],[36.0,30.0],[36.5,29.5],
     [36.2,30.5],[36.0,32.0],[36.5,34.0],[37.0,36.0]],
    [[37.0,36.0],[37.5,37.0],[36.5,36.5],[36.0,35.5],[36.5,34.5],
     [36.2,33.5],[36.3,32.5],[37.0,30.0],[37.5,27.5],[38.0,26.5],
     [38.5,26.8],[39.0,27.0],[40.0,27.0],[40.5,28.5],[41.0,29.0],
     [41.5,31.0],[41.3,33.0],[41.5,35.0],[42.0,38.0],[41.5,41.5]],
    [[41.5,41.5],[42.0,43.0],[43.0,44.0],[43.5,46.5],[42.5,47.5],
     [42.0,49.0],[41.5,50.0],[41.0,49.5],[40.5,50.5],[40.0,49.5],
     [39.5,53.0],[40.0,53.5]],
    [[45.0,36.0],[46.0,36.5],[46.5,37.5],[45.5,38.5],[45.0,37.5],[45.0,36.0]],
    [[50.0,-5.7],[51.0,-5.0],[52.0,-5.2],[53.0,-4.5],[53.5,-3.5],
     [54.0,-3.0],[55.0,-2.0],[56.0,-2.5],[57.0,-2.0],[57.5,-4.0],
     [58.5,-3.0],[58.3,-6.2],[57.5,-7.0],[57.0,-7.5],[56.5,-6.5],
     [56.0,-5.5],[55.5,-5.3],[54.5,-5.5],[54.0,-4.8],[53.0,-4.5]],
    [[50.0,-5.7],[50.5,-1.0],[51.0,0.5],[51.5,1.5],[52.0,1.8],
     [53.0,0.5],[54.0,-0.5],[54.5,-1.0],[55.0,-1.5],[55.5,-2.0]],
    [[57.5,8.0],[58.0,7.5],[59.0,5.5],[60.0,5.0],[61.0,5.5],
     [62.0,6.0],[63.0,8.0],[64.0,8.5],[65.0,14.0],[66.0,14.5],
     [67.0,16.0],[68.0,16.5],[69.0,18.0],[70.0,25.0],[71.0,28.0],
     [70.5,31.0],[69.5,30.5],[69.0,29.0],[68.5,28.5],[67.0,30.5],
     [66.0,29.0],[65.5,25.0],[65.0,25.5],[64.5,24.3],[63.5,22.5],
     [62.0,21.3],[60.0,19.5],[59.0,18.0],[58.5,17.0],[57.5,16.5],
     [56.5,16.0],[56.0,15.5],[55.5,14.0],[55.7,12.5],[55.5,10.5],
     [57.5,8.0]],
    [[57.5,8.0],[56.5,8.5],[56.0,10.5],[57.0,10.5],[57.5,10.0],[57.5,8.0]],
    [[70.0,-141.0],[69.0,-137.0],[68.0,-134.0],[67.0,-140.0],
     [66.0,-143.0],[65.0,-168.0],[64.0,-165.0],[63.5,-162.0],
     [64.0,-160.0],[63.0,-162.0],[62.0,-164.0],[61.0,-166.0],
     [60.0,-162.0],[59.0,-161.0],[58.0,-152.0],[57.0,-153.0],
     [56.0,-158.0],[55.0,-160.0],[54.0,-164.0],[53.5,-167.0]],
    [[70.0,-141.0],[69.0,-137.0],[60.0,-141.0],[59.0,-138.0],
     [58.0,-136.5],[57.0,-135.0],[56.0,-132.0],[55.0,-130.0],
     [54.0,-133.0],[53.0,-132.0],[52.0,-128.5],[51.0,-127.5],
     [50.0,-125.0],[49.0,-124.0],[48.5,-124.5]],
    [[48.5,-124.5],[47.0,-124.2],[46.0,-124.0],[45.0,-124.0],
     [44.0,-124.2],[43.0,-124.5],[42.0,-124.5],[41.0,-124.3],
     [40.0,-124.4],[39.0,-123.8],[38.0,-122.5],[37.0,-122.0],
     [36.0,-121.5],[35.0,-120.8],[34.0,-119.5],[33.0,-117.5],
     [32.5,-117.3]],
    [[32.5,-117.3],[31.0,-116.5],[30.0,-115.8],[29.0,-114.5],
     [28.0,-111.0],[27.0,-110.0],[26.0,-110.0],[25.0,-110.8],
     [24.0,-110.5],[23.0,-109.5],[22.0,-106.0],[21.0,-105.5],
     [20.0,-105.0],[19.0,-104.5],[18.0,-103.5],[17.0,-101.0],
     [16.0,-99.0],[15.0,-92.5],[14.5,-90.0],[14.0,-87.5],
     [13.0,-87.5],[12.0,-87.0],[11.0,-85.5],[10.0,-85.5],
     [9.0,-82.5],[8.5,-83.0]],
    [[8.5,-83.0],[8.0,-77.5],[9.0,-79.5],[9.5,-79.0]],
    [[8.0,-77.5],[7.0,-77.5],[6.0,-77.0],[5.0,-77.5],[4.0,-76.5],
     [3.0,-78.5],[2.0,-80.0],[1.0,-80.0],[0,-80.0],[0,-75.5],
     [1.0,-50.0],[2.0,-50.5],[3.0,-51.5],[4.0,-52.5],[5.0,-57.0],
     [6.0,-60.0],[7.0,-61.0],[8.0,-63.0],[9.0,-63.5],[10.0,-62.5],
     [10.5,-63.0],[11.0,-74.0],[11.5,-72.5],[12.0,-71.0]],
    [[1.0,-50.0],[0,-50.5],[-1.0,-48.5],[-2.0,-44.5],[-3.0,-41.5],
     [-4.0,-37.5],[-5.0,-35.0],[-8.0,-35.0],[-10.0,-37.0],
     [-12.0,-37.5],[-13.0,-39.0],[-15.0,-39.0],[-16.0,-39.5],
     [-18.0,-39.5],[-20.0,-40.5],[-22.0,-43.0],[-23.0,-44.0],
     [-24.0,-47.0],[-25.0,-48.5],[-26.0,-48.5],[-28.0,-49.0],
     [-29.0,-50.0],[-30.0,-51.0],[-31.0,-52.0],[-32.0,-52.5],
     [-33.0,-53.0],[-33.5,-53.5]],
    [[-33.5,-53.5],[-34.0,-58.5],[-35.0,-57.5],[-36.0,-57.0],
     [-38.0,-57.5],[-39.0,-62.0],[-40.0,-62.5],[-41.0,-63.0],
     [-42.0,-65.0],[-43.0,-65.0],[-44.0,-66.0],[-45.0,-66.5],
     [-46.0,-67.5],[-47.0,-66.0],[-48.0,-66.0],[-50.0,-69.0],
     [-51.0,-69.0],[-52.0,-70.5],[-53.0,-71.0],[-54.0,-72.0],
     [-54.9,-65.5]],
    [[-54.9,-65.5],[-54.0,-67.0],[-53.0,-74.0],[-51.0,-75.5],
     [-49.0,-75.0],[-47.0,-74.5],[-45.0,-74.0],[-43.0,-74.0],
     [-41.0,-73.5],[-39.0,-73.5],[-37.0,-73.8],[-35.0,-72.5],
     [-33.0,-71.7],[-31.0,-71.5],[-29.0,-71.3],[-27.0,-70.8],
     [-25.0,-70.7],[-23.0,-70.6],[-21.0,-70.1],[-19.0,-70.2],
     [-17.0,-71.5],[-15.0,-75.0],[-13.0,-76.5],[-11.0,-77.5],
     [-9.0,-78.5],[-7.0,-79.5],[-5.0,-81.0],[-3.0,-80.5],
     [-2.0,-81.0],[0,-80.0]],
    [[-37.8,144.9],[-38.5,146.0],[-39.0,147.0],[-38.0,148.0],
     [-37.0,150.0],[-36.0,150.3],[-35.0,150.8],[-34.0,151.0],
     [-33.5,151.5],[-32.0,152.0],[-31.0,153.0],[-29.0,153.5],
     [-28.0,153.5],[-27.0,153.5],[-26.0,153.2],[-25.0,152.5],
     [-24.0,151.8],[-23.0,150.8],[-22.0,150.3],[-21.0,149.3],
     [-20.0,148.5],[-19.0,147.5],[-18.0,146.3],[-17.0,145.9],
     [-16.0,145.5],[-15.0,145.0],[-14.5,144.5],[-14.0,144.0],
     [-13.5,143.5],[-13.0,143.5]],
    [[-13.0,143.5],[-13.0,136.0],[-13.5,134.5],[-13.0,131.5],
     [-12.0,130.0],[-11.5,130.5],[-12.0,131.0],[-12.5,132.0],
     [-13.5,136.5],[-14.0,135.5],[-14.5,136.0],[-15.0,135.0],
     [-15.5,135.5],[-16.0,136.5],[-17.0,140.0],[-18.0,139.5],
     [-19.0,138.0],[-20.0,137.0],[-21.0,137.5],[-22.0,136.5],
     [-22.5,114.0],[-31.0,115.3],[-32.0,115.7],[-33.0,115.6],
     [-34.0,115.2],[-35.0,117.5],[-34.5,119.0],[-34.5,121.0],
     [-33.5,122.0],[-33.0,124.0],[-33.5,126.0],[-33.0,127.5],
     [-32.0,128.0],[-32.0,133.0],[-32.5,134.0],[-33.0,134.5],
     [-35.0,136.5],[-35.5,138.5],[-36.0,139.5],[-37.8,140.8],
     [-38.0,141.0],[-37.8,144.9]],
    [[-46.5,168.5],[-45.5,167.0],[-44.5,168.0],[-43.5,172.5],
     [-42.5,171.5],[-41.5,171.5],[-40.5,172.0],[-41.0,173.5],
     [-40.5,175.0],[-39.5,176.5],[-38.5,177.5],[-37.5,178.0],
     [-37.0,175.5],[-36.5,175.0],[-37.0,174.8],[-38.0,176.0],
     [-38.5,177.5]],
    [[76.0,-20.0],[75.0,-18.0],[73.0,-22.0],[72.0,-25.0],[70.0,-24.0],
     [68.0,-30.0],[66.0,-35.0],[65.0,-40.0],[63.5,-42.5],[62.0,-42.0],
     [60.5,-44.5],[61.0,-48.0],[62.0,-50.0],[63.0,-52.0],[65.0,-53.0],
     [67.0,-52.0],[68.0,-55.0],[70.0,-55.0],[72.0,-57.0],[74.0,-57.5],
     [76.0,-58.0],[77.0,-62.0],[76.0,-63.5],[75.0,-60.0],[76.0,-55.0],
     [77.0,-18.0],[76.0,-20.0]],
    [[47.0,-53.0],[47.5,-52.5],[48.5,-54.0],[49.0,-53.0],[50.0,-55.5],
     [51.0,-56.5],[52.0,-55.5],[53.0,-56.0],[54.0,-58.5],[55.0,-59.5],
     [56.0,-62.0],[57.0,-64.0],[58.0,-68.0],[59.0,-64.0],[60.0,-64.5],
     [61.0,-69.5],[62.0,-72.0],[63.0,-72.0],[64.0,-76.5],[65.0,-83.0],
     [63.0,-85.0],[61.0,-86.0],[60.0,-90.0],[59.0,-94.0],[58.0,-94.5]],
    [[47.5,-52.5],[47.0,-53.0],[46.5,-53.5],[45.5,-61.0],[44.5,-63.5],
     [43.5,-66.0],[42.0,-70.0],[41.5,-71.0],[41.0,-72.0],[40.5,-74.0],
     [39.5,-74.5],[38.5,-75.0],[37.5,-76.0],[37.0,-76.5],[36.5,-76.0],
     [35.5,-75.5],[34.5,-77.0],[33.5,-78.5],[32.5,-80.5],[31.5,-81.3],
     [30.5,-81.5],[30.0,-81.8],[29.5,-81.5],[29.0,-83.0],[28.5,-83.5],
     [28.0,-82.5],[27.5,-82.5],[27.0,-82.0],[26.5,-82.0],[26.0,-81.8],
     [25.5,-80.2],[25.0,-80.5],[25.5,-81.0]],
    [[25.5,-81.0],[25.5,-80.5],[25.0,-83.5],[24.0,-84.0],[23.5,-88.0],
     [23.0,-89.5],[22.0,-90.5],[21.0,-90.0],[20.5,-90.5],[20.0,-87.5],
     [19.0,-87.5],[18.5,-88.0],[18.0,-88.5],[17.5,-88.0],[17.0,-89.0]],
    [[30.0,-88.5],[30.5,-88.5],[29.5,-89.5],[29.0,-89.5],[28.5,-90.5],
     [29.0,-90.5],[29.0,-91.5],[29.5,-93.0],[29.5,-94.5],[28.5,-96.0],
     [28.0,-97.0],[27.0,-97.5],[26.0,-97.5],[25.5,-97.5]],
    [[22.0,-84.5],[22.5,-83.0],[22.0,-81.0],[22.5,-80.5],[23.0,-81.5],
     [23.5,-82.5],[22.8,-83.8],[22.5,-84.8],[22.0,-84.5]],
  ];
  return raw;
})();

function _drawCoastlines(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number
): void {
  ctx.save();
  ctx.strokeStyle = "rgba(77,180,255,0.55)";
  ctx.lineWidth   = 0.8;
  ctx.lineJoin    = "round";

  COASTLINES.forEach(segment => {
    ctx.beginPath();
    let first = true;
    let prevVisible = false;
    segment.forEach(([lat, lng]) => {
      const p = _project(lat * Math.PI / 180, lng * Math.PI / 180);
      if (!p.visible) { prevVisible = false; first = true; return; }
      const px = cx + p.x * r, py = cy - p.y * r;
      if (first || !prevVisible) { ctx.moveTo(px, py); first = false; }
      else { ctx.lineTo(px, py); }
      prevVisible = true;
    });
    ctx.stroke();
  });
  ctx.restore();
}

function showGlobe(): void {
  (window as any)._globeWrap.classList.add("active");
  const mapEl = document.getElementById("map")!;
  mapEl.style.opacity = "0";
  mapEl.style.pointerEvents = "none";
  if (!GC.canvas) initGlobe();
  if (!GC.raf)   GC.raf = requestAnimationFrame(_drawGlobe);
}

function hideGlobe(): void {
  (window as any)._globeWrap.classList.remove("active");
  const mapEl = document.getElementById("map")!;
  mapEl.style.opacity = "1";
  mapEl.style.pointerEvents = "";
  if (GC.raf) { cancelAnimationFrame(GC.raf); GC.raf = null; }
}

function exitGlobe(): void { hideGlobe(); map.setZoom(4); }
(window as any).exitGlobe = exitGlobe;

map.on("zoomend", () => {
  if (map.getZoom() <= 3) showGlobe();
  else hideGlobe();
});

/* ════════════════════════════════════════
   MAP CLICK — pin location
════════════════════════════════════════ */
map.on("click", (e: any) => {
  if (!S.picking) return;
  S.lat = +e.latlng.lat.toFixed(5);
  S.lng = +e.latlng.lng.toFixed(5);
  (document.getElementById("coordsTxt") as HTMLElement).textContent = `${S.lat}, ${S.lng}`;
  hidePick();
  openModal("postModal");
  toast("📍 Location selected!");
  if (S.tempMarker) map.removeLayer(S.tempMarker);
  S.tempMarker = L.marker([S.lat, S.lng], {
    icon: L.divIcon({
      className: "",
      html: `<div class="mk" style="background:var(--accent2)">+</div>`,
      iconSize: [34, 34], iconAnchor: [17, 34],
    }),
  }).addTo(map);
});

/* ════════════════════════════════════════
   INIT
════════════════════════════════════════ */
async function init(): Promise<void> {
  await delay(1900);
  const loader = document.getElementById("loading")!;
  loader.style.opacity = "0";
  setTimeout(() => loader.remove(), 500);

  S.stories = [];
  renderMarkers();
  renderFeed();
  syncCount();
  addVietnamIslandMarkers();

  // Auto-reconnect Petra — handled by tryAutoReconnect after 2.5s
  // Load likes + comments from server after 3.5s
  setTimeout(loadLikesForStories, 3500);

  _handleDeepLink();
}

function _handleDeepLink(): void {
  const params  = new URLSearchParams(location.search);
  const storyId = params.get("story");
  if (!storyId) return;

  const cleanUrl = location.origin + location.pathname;
  history.replaceState(null, "", cleanUrl);

  let waited = 0;
  const tryOpen = () => {
    const s = S.stories.find((x: any) => x.id === storyId);
    if (s) {
      map.setView([s.lat, s.lng], 13, { animate: false });
      setTimeout(() => showPopup(s), 400);
      return;
    }
    waited += 300;
    if (waited < 12000) setTimeout(tryOpen, 300);
    else toast("⚠ Story not found — it may have been removed");
  };
  setTimeout(tryOpen, 300);
}

/* ════════════════════════════════════════
   MARKERS
════════════════════════════════════════ */
function renderMarkers(): void {
  S.markers.forEach((m: any) => map.removeLayer(m));
  S.markers = [];
  filtered().forEach(addMarker);
  if (typeof (window as any).refreshHeatIfOn === "function") {
    (window as any).refreshHeatIfOn();
  }
}
(window as any).renderMarkers = renderMarkers;

function filtered(): any[] {
  if (S.filter === "all")   return S.stories;
  if (S.filter === "mine")  return S.stories.filter((s: any) => s.isOwn);
  if (S.filter === "chain") return S.stories.filter((s: any) => s.fromChain);
  return S.stories.filter((s: any) => s.cat === S.filter);
}

function addMarker(story: any): void {
  const col   = MOOD_COLOR[story.mood] || "#4dffb4";
  const badge = story.fromChain
    ? `<div class="mk" style="background:${col};filter:drop-shadow(0 2px 6px ${col}55);outline:2px solid #4dffb4">${CAT_EMOJI[story.cat] || "📍"}</div>`
    : `<div class="mk" style="background:${col};filter:drop-shadow(0 2px 6px ${col}55)">${CAT_EMOJI[story.cat] || "📍"}</div>`;
  const icon = L.divIcon({ className: "", html: badge, iconSize: [34, 34], iconAnchor: [17, 34] });
  const m = L.marker([story.lat, story.lng], { icon })
    .addTo(map)
    .on("click", () => showPopup(story));
  S.markers.push(m);
  m._storyId = story.id;
}

function showPopup(story: any): void {
  const imgHtml = story.img
    ? `<img class="pop-img" src="${esc(story.img)}" alt="${esc(story.title)}" onerror="this.style.display='none'">`
    : `<div class="pop-img-placeholder">${CAT_EMOJI[story.cat] || "📍"}</div>`;
  const tags  = (story.tags || []).map((t: string) => `<span class="pop-tag">${esc(t)}</span>`).join("");
  const liked = S.walletAddr && story.likedBy.has(S.walletAddr);
  const chainBadge = story.fromChain
    ? `<div class="pop-chain-badge">⛓ ON-CHAIN · SHELBY TESTNET</div>` : "";
  const cmtCount = Array.isArray(story.commentList) ? story.commentList.length : (story.comments || 0);

  L.popup({ maxWidth: 300, className: "" })
    .setLatLng([story.lat, story.lng])
    .setContent(`
      ${imgHtml}
      <div class="pop-body">
        ${chainBadge}
        <div class="pop-title">${esc(story.mood)} ${esc(story.title)}</div>
        <div class="pop-author">${esc(story.author)} · ${timeAgo(story.time)}</div>
        <div class="pop-desc">${esc(story.desc)}</div>
        <div class="pop-tags">${tags}</div>
        <div class="pop-actions">
          <button class="pop-btn pop-btn-like${liked ? " liked" : ""}" id="poplike-${esc(story.id)}" onclick="likeStory('${esc(story.id)}')">❤ ${story.likes}</button>
          <button class="pop-btn pop-btn-cmt" data-id="${esc(story.id)}" onclick="openCommentModal('${esc(story.id)}')">💬 <span class="pop-cmt-num">${cmtCount}</span></button>
          <button class="pop-btn pop-btn-share" onclick="shareStory('${esc(story.id)}')">↗</button>
        </div>
      </div>`)
    .openOn(map);
}

/* ════════════════════════════════════════
   FEED
════════════════════════════════════════ */
function renderFeed(): void {
  const el = document.getElementById("storyList")!;
  el.innerHTML = [...filtered()].sort((a: any, b: any) => b.time - a.time).map(cardHTML).join("");
}
(window as any).renderFeed = renderFeed;

function cardHTML(s: any): string {
  const liked    = S.walletAddr && s.likedBy.has(S.walletAddr);
  const imgPart  = s.img
    ? `<img class="scard-img" src="${esc(s.img)}" alt="${esc(s.title)}" loading="lazy" onerror="this.style.display='none'">`
    : `<div class="scard-img-placeholder">${CAT_EMOJI[s.cat] || "📍"}</div>`;
  const desc      = esc(s.desc).slice(0, 100) + (s.desc.length > 100 ? "..." : "");
  const chainPill = s.fromChain ? `<span class="chain-pill">⛓ ON-CHAIN</span>` : "";
  const commentCount = Array.isArray(s.commentList) ? s.commentList.length : (s.comments || 0);
  return `
  <div class="scard" onclick="flyTo(${s.lat},${s.lng},'${esc(s.id)}')">
    ${imgPart}
    <div class="scard-body">
      <div class="scard-header">
        <span class="scard-mood">${esc(s.mood)}</span>
        <div class="scard-title">${esc(s.title)}</div>
        ${chainPill}
      </div>
      <div class="scard-meta">
        <span class="scard-author">${esc(s.author)}</span>
        <span class="scard-tag">${CAT_EMOJI[s.cat] || ""} ${esc(s.cat)}</span>
        <span class="scard-time">${timeAgo(s.time)}</span>
      </div>
      ${desc ? `<div class="scard-desc">${desc}</div>` : ""}
      <div class="scard-reactions">
        <button class="rxn-btn rxn-like${liked ? " liked" : ""}" id="card-like-${esc(s.id)}" onclick="event.stopPropagation();likeStory('${esc(s.id)}')">
          <span class="rxn-icon">❤</span><span class="rxn-num">${s.likes}</span>
        </button>
        <button class="rxn-btn rxn-cmt" data-id="${esc(s.id)}" onclick="event.stopPropagation();openCommentModal('${esc(s.id)}')">
          <span class="rxn-icon">💬</span><span class="rxn-num">${commentCount}</span>
        </button>
        <button class="rxn-btn rxn-share" onclick="event.stopPropagation();shareStory('${esc(s.id)}')">
          <span class="rxn-icon">↗</span>
        </button>
      </div>
    </div>
  </div>`;
}

function flyTo(lat: number, lng: number, id: string): void {
  if ((window as any)._globeWrap?.classList.contains("active")) exitGlobe();
  map.flyTo([lat, lng], 12, { duration: 1.5 });
  map.once("moveend", () => {
    const s = S.stories.find((x: any) => x.id === id);
    if (s) showPopup(s);
  });
}
(window as any).flyTo = flyTo;

/* ════════════════════════════════════════
   AIP-62 WALLET STANDARD
════════════════════════════════════════ */
function isAptosWallet(wallet: any): boolean {
  if (!wallet?.features) return false;
  return "aptos:connect" in wallet.features && "aptos:disconnect" in wallet.features;
}

function getAptosWallets(): {
  aptosWallets: any[];
  on: (event: string, cb: (...args: any[]) => void) => () => void;
} {
  const { get, on } = getWallets();
  return { aptosWallets: Array.from(get()).filter(isAptosWallet), on: on as any };
}

const UserResponseStatus = {
  APPROVED: "Approved",
  REJECTED: "Rejected",
} as const;
type UserResponseStatus = typeof UserResponseStatus[keyof typeof UserResponseStatus];

/* ════════════════════════════════════════
   CONFIG
════════════════════════════════════════ */
const NETWORK        = Network.TESTNET;
const SERVER_ACCOUNT = (import.meta as any).env.VITE_SHELBY_ACCOUNT_ADDRESS ?? "";

let _autoLoadDone    = false;
let _autoLoadPromise: Promise<void> | null = null;

/* ════════════════════════════════════════
   WALLET STATE
════════════════════════════════════════ */
let _connectedWallet: any = null;

function getInstalledAptosWallets(): any[] {
  return Array.from(getAptosWallets().aptosWallets);
}

function findWalletByName(name: string): any | null {
  return getInstalledAptosWallets().find(
    (w: any) => w.name.toLowerCase() === name.toLowerCase()
  ) ?? null;
}

function waitForWallet(name: string, maxMs = 3000): Promise<any | null> {
  const found = findWalletByName(name);
  if (found) return Promise.resolve(found);
  return new Promise(resolve => {
    const { on } = getAptosWallets();
    let done = false;
    const cleanup = on("register", () => {
      const w = findWalletByName(name);
      if (w && !done) { done = true; cleanup(); clearTimeout(timer); resolve(w); }
    });
    const timer = setTimeout(() => {
      if (!done) { done = true; cleanup(); resolve(null); }
    }, maxMs);
  });
}

/* ════════════════════════════════════════
   HELPERS (wallet-specific)
════════════════════════════════════════ */
const getMetaMask = (): any => (window as any).ethereum ?? null;

function shortAddr(addr: string, len = 6): string {
  return addr.slice(0, len) + "..." + addr.slice(-4);
}

function toast(msg: string): void {
  const el = document.getElementById("toast")!;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout((window as any)._toastTimer);
  (window as any)._toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}
(window as any).toast = toast;

function syncCount(): void {
  (document.getElementById("storyCount") as HTMLElement).textContent = String(S.stories.length);
}
(window as any).syncCount = syncCount;

/* ════════════════════════════════════════
   WALLET UI
════════════════════════════════════════ */
function setWalletUI(addr: string, type: "petra" | "metamask" | "demo"): void {
  S.walletAddr = addr;
  S.walletType = type;
  const btn = document.getElementById("walletBtn")!;
  btn.textContent = shortAddr(addr);
  btn.className   = "connected";
  btn.onclick     = toggleProfile;
  const profAddr = document.getElementById("profAddr");
  if (profAddr) profAddr.textContent = addr;
}

function clearWalletUI(): void {
  const btn = document.getElementById("walletBtn")!;
  btn.textContent = "CONNECT WALLET";
  btn.className   = "";
  btn.onclick     = () => openModal("walletModal");
  const profAddr = document.getElementById("profAddr");
  if (profAddr) profAddr.textContent = "—";
}

/* ════════════════════════════════════════
   WALLET MODAL — AIP-62
════════════════════════════════════════ */
function getWalletListForUI(): { name: string; icon: string; installed: boolean }[] {
  const installed      = getInstalledAptosWallets();
  const known          = ["Petra"];
  const installedNames = new Set(installed.map((w: any) => w.name));
  const result         = installed.map((w: any) => ({ name: w.name, icon: w.icon ?? "", installed: true }));
  for (const name of known) {
    if (!installedNames.has(name)) result.push({ name, icon: "", installed: false });
  }
  return result;
}

function renderWalletOptions(): void {
  const container = document.querySelector("#walletModal .modal-body") as HTMLElement;
  if (!container) return;

  const wallets  = getWalletListForUI();
  const demoOpt  = container.querySelector('.wallet-opt[onclick*="demo"]');
  container.querySelectorAll(".wallet-opt, .wallet-section-title").forEach(el => el.remove());

  const aptosTitle = document.createElement("div");
  aptosTitle.className   = "wallet-section-title";
  aptosTitle.textContent = "APTOS WALLETS";
  container.appendChild(aptosTitle);

  const installUrls: Record<string, string> = { "Petra": "https://petra.app" };

  for (const w of wallets) {
    const div     = document.createElement("div");
    div.className = "wallet-opt" + (w.installed ? "" : " wallet-opt--uninstalled");

    const iconEl      = document.createElement("div");
    iconEl.className  = "wallet-icon";
    if (w.icon?.startsWith("data:")) {
      const img = document.createElement("img") as HTMLImageElement;
      img.src = w.icon; img.width = 28; img.height = 28;
      img.style.borderRadius = "6px";
      iconEl.appendChild(img);
    } else {
      iconEl.textContent = "🦊";
    }

    const infoEl      = document.createElement("div");
    const nameEl      = document.createElement("div");
    nameEl.className  = "wallet-name";
    nameEl.textContent = w.name;
    const chainEl     = document.createElement("div");
    chainEl.className = "wallet-chain";
    chainEl.textContent = w.installed ? "Aptos · AIP-62" : "Not installed — click to install";
    infoEl.appendChild(nameEl);
    infoEl.appendChild(chainEl);
    div.appendChild(iconEl);
    div.appendChild(infoEl);

    div.onclick = w.installed
      ? () => _connectWalletReal(w.name)
      : () => window.open(installUrls[w.name] ?? "https://aptos.dev/tools/aptos-wallet-listing", "_blank");

    container.appendChild(div);
  }

  const evmTitle = document.createElement("div");
  evmTitle.className      = "wallet-section-title";
  evmTitle.style.marginTop = "12px";
  evmTitle.textContent    = "EVM WALLETS";
  container.appendChild(evmTitle);

  const mmDiv      = document.createElement("div");
  mmDiv.className  = "wallet-opt";
  mmDiv.innerHTML  = `<div class="wallet-icon">🦊</div>
    <div><div class="wallet-name">MetaMask</div>
    <div class="wallet-chain">Ethereum / EVM</div></div>`;
  mmDiv.onclick    = () => _connectWalletReal("metamask");
  container.appendChild(mmDiv);

  if (demoOpt) {
    const sep = document.createElement("div");
    sep.className      = "wallet-section-title";
    sep.style.marginTop = "12px";
    sep.textContent    = "TESTNET";
    container.appendChild(sep);
    container.appendChild(demoOpt as Node);
  }
}
(window as any).renderWalletOptions = renderWalletOptions;

(function initWalletListener() {
  const { on } = getAptosWallets();
  const rerender = () => {
    const modal = document.getElementById("walletModal");
    if (modal?.classList.contains("open")) renderWalletOptions();
  };
  on("register",   rerender);
  on("unregister", rerender);
})();

/* ════════════════════════════════════════
   CONNECT — Aptos AIP-62
════════════════════════════════════════ */
async function connectAptosWallet(walletName: string): Promise<void> {
  toast(`🔍 Looking for ${walletName}...`);
  const wallet = await waitForWallet(walletName, 3000);

  if (!wallet) {
    toast(`❌ ${walletName} is not installed`);
    const urls: Record<string, string> = { "Petra": "https://petra.app" };
    if (urls[walletName]) setTimeout(() => window.open(urls[walletName], "_blank"), 800);
    return;
  }

  _connectedWallet = wallet;
  toast(`🔗 Connecting to ${wallet.name}...`);

  try {
    const connectFn = wallet.features["aptos:connect"]?.connect;
    if (!connectFn) throw new Error(`${wallet.name} does not support aptos:connect`);

    const response = await connectFn({ silent: false, networkInfo: { name: NETWORK } });

    if (response.status !== UserResponseStatus.APPROVED) {
      toast("❌ User cancelled connection");
      _connectedWallet = null;
      return;
    }

    const addr = response.args.address.toString();

    const networkFn = wallet.features["aptos:network"]?.network;
    if (networkFn) {
      const net = await networkFn();
      if (net?.name?.toLowerCase() !== "testnet") {
        toast(`⚠ Please switch ${wallet.name} to Testnet`);
        await wallet.features["aptos:disconnect"]?.disconnect?.().catch(() => {});
        _connectedWallet = null;
        return;
      }
    }

    setWalletUI(addr, "petra");
    toast(`✅ ${wallet.name}: ${shortAddr(addr)}`);
    loadUserStories(addr);

    wallet.features["aptos:onAccountChange"]?.onAccountChange?.((newAcc: any) => {
      if (!newAcc) { doDisconnect(); return; }
      const newAddr = newAcc.address?.toString();
      if (!newAddr) { doDisconnect(); return; }
      setWalletUI(newAddr, "petra");
      toast(`🔄 Account switched: ${shortAddr(newAddr)}`);
      loadUserStories(newAddr);
    });

    wallet.features["aptos:onNetworkChange"]?.onNetworkChange?.((net: any) => {
      if (net?.name?.toLowerCase() !== "testnet") {
        toast(`⚠ ${wallet.name} has left Testnet`);
      }
    });

  } catch (err: any) {
    _connectedWallet = null;
    const isCancel = err?.message?.includes("Unauthorized")
      || err?.code === 4001
      || err?.message?.includes("User rejected");
    toast(isCancel ? "❌ Connection cancelled" : `❌ ${wallet.name} error: ${err?.message ?? err}`);
    console.error(`[GeoStory] ${wallet.name} connect error:`, err);
  }
}

/* ════════════════════════════════════════
   CONNECT — MetaMask
════════════════════════════════════════ */
async function connectMetaMask(): Promise<void> {
  const eth = getMetaMask();
  if (!eth) {
    toast("❌ MetaMask is not installed");
    setTimeout(() => window.open("https://metamask.io", "_blank"), 800);
    return;
  }
  toast("🔗 Connecting to MetaMask...");
  try {
    const accounts: string[] = await eth.request({ method: "eth_requestAccounts" });
    if (!accounts.length) { toast("❌ No accounts found"); return; }
    setWalletUI(accounts[0], "metamask");
    toast(`✅ MetaMask: ${shortAddr(accounts[0])} (view only — upload requires Aptos wallet)`);
    eth.on("accountsChanged", (accs: string[]) => {
      if (!accs.length) { doDisconnect(); return; }
      setWalletUI(accs[0], "metamask");
    });
    eth.on("disconnect", () => doDisconnect());
  } catch (err: any) {
    if (err?.code === 4001) { toast("❌ Connection cancelled"); return; }
    toast(`❌ MetaMask error: ${err?.message ?? err}`);
  }
}

/* ════════════════════════════════════════
   CONNECT — Demo
════════════════════════════════════════ */
async function connectDemo(): Promise<void> {
  toast("🔑 Initializing demo mode...");
  await delay(400);
  const addr = "0xDEMO_" + Math.random().toString(16).slice(2, 8).toUpperCase();
  setWalletUI(addr, "demo");
  toast("✅ Demo mode — data is stored temporarily only");
}

/* ════════════════════════════════════════
   DISCONNECT
════════════════════════════════════════ */
function doDisconnect(): void {
  if (S.walletType === "petra" && _connectedWallet) {
    _connectedWallet.features["aptos:disconnect"]?.disconnect?.().catch(() => {});
    _connectedWallet = null;
  }
  S.walletAddr = null;
  S.walletType = null;
  localStorage.setItem("geostory_disconnected", "1");
  clearWalletUI();
  const card = document.getElementById("profileCard");
  if (card) card.style.display = "none";
  toast("🔌 Disconnected");
}

/* ════════════════════════════════════════
   AUTO RECONNECT
════════════════════════════════════════ */
async function tryAutoReconnect(): Promise<void> {
  if (localStorage.getItem("geostory_disconnected") === "1") return;
  await delay(300);
  const installed = getInstalledAptosWallets();
  if (!installed.length) return;
  for (const wallet of installed) {
    try {
      const connectFn = wallet.features["aptos:connect"]?.connect;
      if (!connectFn) continue;
      const response = await connectFn({ silent: true });
      if (response.status !== UserResponseStatus.APPROVED) continue;
      const addr = response.args.address.toString();
      _connectedWallet = wallet;
      setWalletUI(addr, "petra");
      toast(`⏳ Loading stories from Shelby...`);
      loadUserStories(addr);
      break;
    } catch (_) { /* no previous session */ }
  }
}

/* ════════════════════════════════════════
   WALLET ENTRY POINT
   index.js connectWallet() fallback → now handled here directly
════════════════════════════════════════ */
(window as any)._pendingWalletConnect = null;

async function _connectWalletReal(type: string): Promise<void> {
  localStorage.removeItem("geostory_disconnected");
  closeModal("walletModal");
  switch (type.toLowerCase()) {
    case "metamask": return connectMetaMask();
    case "demo":     return connectDemo();
    default:         return connectAptosWallet(type);
  }
}

(window as any)._connectWalletReal = _connectWalletReal;
(window as any).connectWallet      = _connectWalletReal;
(window as any).disconnect         = doDisconnect;

const _pending = (window as any)._pendingWalletConnect;
if (_pending) {
  (window as any)._pendingWalletConnect = null;
  _connectWalletReal(_pending);
}

/* ════════════════════════════════════════
   WALLET UI ACTIONS
════════════════════════════════════════ */
function toggleProfile(): void {
  const el   = document.getElementById("profileCard")!;
  const open = el.style.display === "block";
  el.style.display = open ? "none" : "block";
  if (!open) {
    const mine = S.stories.filter((s: any) => s.isOwn);
    (document.getElementById("profStories") as HTMLElement).textContent = String(mine.length);
    (document.getElementById("profLikes") as HTMLElement).textContent   = String(mine.reduce((a: number, s: any) => a + s.likes, 0));
  }
}
(window as any).toggleProfile = toggleProfile;

/* ════════════════════════════════════════
   POST FLOW
════════════════════════════════════════ */
function startPost(): void {
  if (!S.walletAddr) { openModal("walletModal"); return; }
  if (S.walletType === "demo") {
    toast("⚠ Demo mode: connect Petra to post on-chain");
    return;
  }
  if (!S.lat) { toast("📍 Click the map to pick a location"); startPick(); }
  else openModal("postModal");
}
(window as any).startPost = startPost;

function startPick(): void {
  closeModal("postModal");
  S.picking = true;
  document.getElementById("pickBar")!.classList.add("show");
  map.getContainer().style.cursor = "crosshair";
}
(window as any).startPick = startPick;

function hidePick(): void {
  S.picking = false;
  document.getElementById("pickBar")!.classList.remove("show");
  map.getContainer().style.cursor = "";
}

function cancelPick(): void { hidePick(); openModal("postModal"); }
(window as any).cancelPick = cancelPick;

function handleImg(e: Event): void {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { toast("⚠ Image max 5MB"); return; }
  const reader = new FileReader();
  reader.onload = ev => {
    S.imgData = (ev.target as FileReader).result as string;
    const p = document.getElementById("imgPreview") as HTMLImageElement;
    p.src = S.imgData; p.style.display = "block";
  };
  reader.readAsDataURL(file);
}
(window as any).handleImg = handleImg;

function pickMood(btn: HTMLElement): void {
  S.mood = btn.dataset.mood!;
  document.querySelectorAll(".mood-opt").forEach(b => b.classList.remove("sel"));
  btn.classList.add("sel");
}
(window as any).pickMood = pickMood;

function pickCat(chip: HTMLElement): void {
  S.cat = chip.dataset.cat!;
  document.querySelectorAll(".cat-chip").forEach(c => c.classList.remove("sel"));
  chip.classList.add("sel");
}
(window as any).pickCat = pickCat;

async function submitStory(): Promise<void> {
  const title = (document.getElementById("iTitle") as HTMLInputElement).value.trim();
  const desc  = (document.getElementById("iDesc")  as HTMLTextAreaElement).value.trim();

  if (!title)  { toast("⚠ Please enter a title"); return; }
  if (!S.lat)  { toast("⚠ Pick a location on the map"); return; }
  if (!S.walletAddr) { openModal("walletModal"); return; }

  const btn  = document.getElementById("subBtn") as HTMLButtonElement;
  const prog = document.getElementById("progWrap")!;
  btn.disabled = true;
  btn.textContent = "⏳ Uploading to Shelby...";
  prog.classList.add("show");

  try {
    if (!(window as any).shelby) {
      btn.textContent = "⏳ Connecting to Shelby...";
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("main.ts not loaded yet, please reload the page")), 5000);
        window.addEventListener("shelby:ready", () => { clearTimeout(t); resolve(undefined); }, { once: true });
      });
    }
    btn.textContent = "⏳ Uploading to Shelby...";
    const shelbyAPI = (window as any).shelby;
    const result = await shelbyAPI.upload({
      title, desc, image: S.imgData,
      lat: S.lat, lng: S.lng, mood: S.mood, cat: S.cat,
      wallet: S.walletAddr,
    });

    const story = {
      id: "s" + Date.now(),
      title, desc,
      lat: S.lat, lng: S.lng,
      author:   S.walletAddr.slice(0, 8) + "..." + S.walletAddr.slice(-4),
      fullAddr: S.walletAddr,
      mood: S.mood, cat: S.cat, tags: [S.cat],
      likes: 0, comments: 0, time: Date.now(),
      img: result.imageUrl || S.imgData,
      cid: result.cid,
      isOwn: true,
      fromChain: !S.walletAddr.startsWith("0xDEMO"),
      likedBy: new Set(),
    };

    S.stories.unshift(story);
    addMarker(story);
    renderFeed(); syncCount();

    S.lat = S.lng = null; S.imgData = null; S.mood = "😊"; S.cat = "photo";
    (document.getElementById("iTitle") as HTMLInputElement).value = "";
    (document.getElementById("iDesc")  as HTMLTextAreaElement).value = "";
    (document.getElementById("imgPreview") as HTMLImageElement).style.display = "none";
    (document.getElementById("imgFile")   as HTMLInputElement).value = "";
    (document.getElementById("coordsTxt") as HTMLElement).textContent = "Not selected";
    document.querySelectorAll(".mood-opt").forEach(b =>
      (b as HTMLElement).classList.toggle("sel", (b as HTMLElement).dataset.mood === "😊"));
    document.querySelectorAll(".cat-chip").forEach(c =>
      (c as HTMLElement).classList.toggle("sel", (c as HTMLElement).dataset.cat === "photo"));
    if (S.tempMarker) { map.removeLayer(S.tempMarker); S.tempMarker = null; }

    prog.classList.remove("show");
    btn.disabled = false; btn.textContent = "✦ PUBLISH TO SHELBY";
    closeModal("postModal");

    const cidShort = result.cid.slice(0, 28) + "...";
    toast(`✅ Story published on-chain!\n${cidShort}`);
    map.flyTo([story.lat, story.lng], 14, { duration: 2 });

  } catch (err: any) {
    console.error("[GeoStory] submitStory error:", err);
    prog.classList.remove("show");
    btn.disabled = false; btn.textContent = "✦ PUBLISH TO SHELBY";
    toast(`❌ Upload failed: ${err?.message ?? err}`);
  }
}
(window as any).submitStory = submitStory;

/* ════════════════════════════════════════
   REFRESH FROM SHELBY (manual)
════════════════════════════════════════ */
async function refreshFromShelby(): Promise<void> {
  if (!S.walletAddr || S.walletAddr.startsWith("0xDEMO")) {
    toast("⚠ Connect Petra to load stories from chain");
    return;
  }
  if (S.shelbyLoading) return;
  S.shelbyLoading = true;
  toast("🔄 Loading from Shelby...");
  try {
    await (window as any).loadUserStoriesFromShelby?.(S.walletAddr);
  } catch (e: any) {
    toast("❌ " + (e?.message ?? e));
  } finally {
    S.shelbyLoading = false;
  }
}
(window as any).refreshFromShelby = refreshFromShelby;

/* ════════════════════════════════════════
   window.shelby.upload
════════════════════════════════════════ */
(window as any).shelby = {
  upload: async (data: {
    title:  string;
    desc:   string;
    image:  string | null;
    lat:    number;
    lng:    number;
    mood:   string;
    cat:    string;
    wallet: string;
  }): Promise<{ cid: string; txHash?: string; imageUrl?: string }> => {

    if (data.image) {
      const commaIdx = data.image.indexOf(",");
      if (commaIdx === -1) throw new Error("Invalid image — please select again");
      const b64Len    = data.image.length - commaIdx - 1;
      const sizeBytes = Math.ceil(b64Len * 3 / 4);
      if (sizeBytes > 3 * 1024 * 1024) throw new Error("Image must be under 3MB — please choose a smaller image");
    }

    const payload = {
      title:       data.title,
      description: data.desc,
      lat:         data.lat,
      lng:         data.lng,
      mood:        data.mood,
      category:    data.cat,
      author:      data.wallet,
      imageBase64: data.image ?? undefined,
    };

    const res = await fetch("https://geostory-0wfq.onrender.com/api/stories", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
    });

    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch {
      throw new Error(`Server error ${res.status} — response is not JSON: ${text.slice(0, 120)}`);
    }
    if (!res.ok || !json.success) throw new Error(json.error ?? `Upload failed (${res.status})`);
    return { cid: json.blobName, txHash: undefined, imageUrl: json.imageUrl };
  },
};

/* ════════════════════════════════════════
   LOAD STORIES
════════════════════════════════════════ */
export async function loadStoriesFromShelby(accountAddress: string): Promise<any[]> {
  try {
    const res  = await fetch("https://geostory-0wfq.onrender.com/api/stories");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const data = JSON.parse(text);
    if (Array.isArray(data.stories)) {
      return data.stories.map((s: any) => normalizeStory(s, accountAddress));
    }
  } catch (e) {
    console.warn("[GeoStory] /api/stories error:", e);
  }
  return [];
}

function normalizeStory(data: any, currentAccount: string): any {
  const author   = data.author ?? currentAccount;
  const blobName = data._blobName ?? data.id ?? "";
  const img      = data.imageBase64 ?? data.imageUrl ?? null;
  return {
    id:        data.id          ?? blobName,
    title:     data.title       ?? "Untitled",
    desc:      data.description ?? data.desc ?? "",
    lat:       Number(data.lat),
    lng:       Number(data.lng),
    author:    shortAddr(author),
    fullAddr:  author,
    mood:      data.mood        ?? "😊",
    cat:       data.category    ?? data.cat ?? "photo",
    tags:      data.tags        ?? [data.category ?? "photo"],
    likes:     0,
    comments:  0,
    time:      data.time        ?? data.createdAt ?? Date.now(),
    img,
    cid:       `shelby://${author}/${blobName}`,
    isOwn:     false,
    likedBy:   new Set<string>(),
    fromChain: true,
    _blobName: blobName,
  };
}

async function loadUserStories(address: string): Promise<void> {
  try {
    if (_autoLoadPromise) await _autoLoadPromise;

    if (_autoLoadDone) {
      S.stories.forEach((s: any) => {
        s.isOwn = s.fullAddr?.toLowerCase() === address.toLowerCase();
      });
      (window as any).renderFeed?.();
      (window as any).renderMarkers?.();
      return;
    }

    toast("⏳ Loading stories from Shelby...");
    const targetAccount = SERVER_ACCOUNT || address;
    const stories       = await loadStoriesFromShelby(targetAccount);

    if (!stories.length) { toast("📭 No stories found on Shelby"); return; }

    const existing = new Set(S.stories.map((s: any) => s.id));
    const merged   = stories.map((s: any) => ({
      ...s,
      isOwn: s.fullAddr?.toLowerCase() === address.toLowerCase(),
    }));
    const fresh = merged.filter((s: any) => !existing.has(s.id));

    S.stories = [...fresh, ...S.stories];
    (window as any).renderMarkers?.();
    (window as any).renderFeed?.();
    syncCount();
    const n = fresh.length;
    toast(`✅ Loaded ${n} stor${n === 1 ? "y" : "ies"} from Shelby`);
    setTimeout(() => (window as any).loadLikesForStories?.(), 500);

  } catch (err: any) {
    console.error("[GeoStory] loadUserStories:", err);
    toast("⚠ Could not load stories: " + (err?.message ?? err));
  }
}

/* ════════════════════════════════════════
   REACTIONS — likes
════════════════════════════════════════ */
async function loadLikesForStories(): Promise<void> {
  if (!S.stories.length) return;
  try {
    const targets = S.stories.filter((s: any) => s.fromChain).slice(0, 20);
    if (!targets.length) return;

    const CHUNK = 5;
    for (let i = 0; i < targets.length; i += CHUNK) {
      const batch = targets.slice(i, i + CHUNK);
      await Promise.allSettled(
        batch.map(async (s: any) => {
          try {
            const ctrl  = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 4000);
            const r     = await fetch(`https://geostory-0wfq.onrender.com/api/stories/${s.id}/likes`, { signal: ctrl.signal });
            clearTimeout(timer);
            if (!r.ok) return;
            const data  = await r.json();
            s.likes     = typeof data.count === "number" ? data.count : 0;
            s.likedBy   = new Set(Array.isArray(data.likedBy) ? data.likedBy : []);
          } catch { /* timeout/network error → skip */ }
        })
      );
    }

    renderFeed();
    S.stories.forEach((s: any) => _updateLikeButtons(s));
    setTimeout(loadCommentsForStories, 800);
  } catch (e) {
    console.warn("[GeoStory] loadLikesForStories:", e);
  }
}
(window as any).loadLikesForStories = loadLikesForStories;

async function likeStory(id: string): Promise<void> {
  if (!S.walletAddr) { toast("Connect wallet to like"); return; }
  const s = S.stories.find((x: any) => x.id === id);
  if (!s) return;

  const alreadyLiked = s.likedBy.has(S.walletAddr);
  if (alreadyLiked) { s.likedBy.delete(S.walletAddr); s.likes = Math.max(0, s.likes - 1); }
  else              { s.likedBy.add(S.walletAddr);    s.likes++; }

  _updateLikeButtons(s);
  renderFeed();

  if (!s.fromChain || S.walletAddr.startsWith("0xDEMO")) {
    toast(alreadyLiked ? "💔 Unliked" : "❤ Liked!");
    return;
  }

  try {
    const r = await fetch(`https://geostory-0wfq.onrender.com/api/stories/${id}/like`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ wallet: S.walletAddr }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error ?? "Like failed");

    s.likes   = data.count ?? s.likes;
    s.likedBy = new Set(Array.isArray(data.likedBy) ? data.likedBy : [...s.likedBy]);
    _updateLikeButtons(s);
    renderFeed();

    toast(data.action === "liked" ? "❤ Liked!" : "💔 Unliked");
  } catch (err: any) {
    if (alreadyLiked) { s.likedBy.add(S.walletAddr!); s.likes++; }
    else              { s.likedBy.delete(S.walletAddr!); s.likes = Math.max(0, s.likes - 1); }
    renderFeed();
    toast("⚠ Could not save like: " + (err?.message ?? err));
    console.error("[GeoStory] likeStory error:", err);
  }
}
(window as any).likeStory = likeStory;

function _updateLikeButtons(s: any): void {
  const liked = S.walletAddr && s.likedBy.has(S.walletAddr);
  const cardBtn = document.getElementById(`card-like-${s.id}`);
  if (cardBtn) {
    cardBtn.querySelector(".rxn-num")!.textContent = s.likes;
    cardBtn.classList.toggle("liked", !!liked);
  }
  const popBtn = document.getElementById(`poplike-${s.id}`);
  if (popBtn) {
    popBtn.textContent = `❤ ${s.likes}`;
    popBtn.classList.toggle("liked", !!liked);
  }
}

/* ════════════════════════════════════════
   COMMENT SYSTEM
════════════════════════════════════════ */
async function loadComments(storyId: string): Promise<any[]> {
  const s = S.stories.find((x: any) => x.id === storyId);
  if (!s) return [];
  if (Array.isArray(s.commentList) && s._cmtLoaded) return s.commentList;
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r     = await fetch(`https://geostory-0wfq.onrender.com/api/stories/${storyId}/comments`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return [];
    const data = await r.json();
    s.commentList = Array.isArray(data.comments) ? data.comments : [];
    s.comments    = s.commentList.length;
    s._cmtLoaded  = true;
    return s.commentList;
  } catch { return []; }
}

async function openCommentModal(storyId: string): Promise<void> {
  const s = S.stories.find((x: any) => x.id === storyId);
  if (!s) return;

  let modal = document.getElementById("commentModal") as any;
  if (!modal) {
    modal = document.createElement("div");
    modal.id        = "commentModal";
    modal.className = "overlay";
    modal.innerHTML = `
      <div class="modal cmt-modal" onclick="event.stopPropagation()">
        <div class="modal-head">
          <div>
            <div class="modal-title" id="cmtModalTitle">Comments</div>
            <div class="modal-sub" id="cmtModalSub">// STORED ON SHELBY</div>
          </div>
          <button class="modal-x" onclick="closeModal('commentModal')">✕</button>
        </div>
        <div class="cmt-list" id="cmtList"></div>
        <div class="cmt-input-wrap">
          <textarea class="cmt-input" id="cmtInput" placeholder="Write a comment..." maxlength="280"></textarea>
          <button class="cmt-send" id="cmtSendBtn" onclick="submitComment()">↑ SEND</button>
        </div>
      </div>`;
    modal.addEventListener("click", (e: Event) => {
      if (e.target === modal) closeModal("commentModal");
    });
    document.body.appendChild(modal);
  }

  modal._storyId = storyId;
  (document.getElementById("cmtModalTitle") as HTMLElement).textContent = `${s.mood} ${s.title}`;
  (document.getElementById("cmtModalSub")   as HTMLElement).textContent = `// ${s.fromChain ? "SHELBY · ON-CHAIN" : "LOCAL"}`;
  (document.getElementById("cmtInput")      as HTMLTextAreaElement).value = "";
  openModal("commentModal");
  renderComments(storyId, []);

  const comments = await loadComments(storyId);
  renderComments(storyId, comments);
}
(window as any).openCommentModal = openCommentModal;

function renderComments(storyId: string, comments: any[]): void {
  const el = document.getElementById("cmtList");
  if (!el) return;
  if (!comments.length) {
    el.innerHTML = '<div class="cmt-empty">No comments yet — be the first! 💬</div>';
    return;
  }
  el.innerHTML = comments.map(c => `
    <div class="cmt-item">
      <div class="cmt-meta">
        <span class="cmt-wallet">${esc(c.wallet ? c.wallet.slice(0,8) + "..." + c.wallet.slice(-4) : "anon")}</span>
        <span class="cmt-time">${timeAgo(c.time)}</span>
      </div>
      <div class="cmt-text">${esc(c.text)}</div>
    </div>`).join("");
  el.scrollTop = el.scrollHeight;
}

async function submitComment(): Promise<void> {
  const modal = document.getElementById("commentModal") as any;
  if (!modal) return;
  const storyId = modal._storyId;
  if (!storyId) return;

  if (!S.walletAddr) { toast("Connect wallet to comment"); return; }
  if (S.walletAddr.startsWith("0xDEMO")) { toast("⚠ Demo mode — comments not saved on-chain"); return; }

  const input = document.getElementById("cmtInput") as HTMLTextAreaElement;
  const text  = input.value.trim();
  if (!text) { toast("⚠ Write something first"); return; }

  const btn = document.getElementById("cmtSendBtn") as HTMLButtonElement;
  btn.disabled    = true;
  btn.textContent = "...posting";

  try {
    const r = await fetch(`https://geostory-0wfq.onrender.com/api/stories/${storyId}/comments`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ wallet: S.walletAddr, text }),
    });
    const data = await r.json();
    if (!r.ok || !data.success) throw new Error(data.error ?? "Failed");

    const s = S.stories.find((x: any) => x.id === storyId);
    if (s) {
      if (!Array.isArray(s.commentList)) s.commentList = [];
      s.commentList.push(data.comment);
      s.comments = s.commentList.length;
    }
    input.value = "";
    renderComments(storyId, s?.commentList || []);

    const newCount = s?.comments ?? data.count ?? 0;
    const cardCmtNum = document.querySelector(`.rxn-cmt[data-id="${storyId}"] .rxn-num`);
    if (cardCmtNum) cardCmtNum.textContent = String(newCount);
    const popCmtBtn = document.querySelector(`.pop-btn-cmt[data-id="${storyId}"] .pop-cmt-num`);
    if (popCmtBtn) popCmtBtn.textContent = String(newCount);

    toast("💬 Comment posted on-chain!");
  } catch (err: any) {
    toast("⚠ Could not post: " + (err?.message ?? err));
  } finally {
    btn.disabled    = false;
    btn.textContent = "↑ POST";
  }
}
(window as any).submitComment = submitComment;

async function loadCommentsForStories(): Promise<void> {
  const targets = S.stories.filter((s: any) => s.fromChain).slice(0, 20);
  if (!targets.length) return;
  const CHUNK = 5;
  for (let i = 0; i < targets.length; i += CHUNK) {
    await Promise.allSettled(targets.slice(i, i + CHUNK).map((s: any) => loadComments(s.id)));
  }
  renderFeed();
}
(window as any).loadCommentsForStories = loadCommentsForStories;

function shareStory(id: string): void {
  const base = location.origin + location.pathname;
  const url  = base + "?story=" + encodeURIComponent(id);
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url)
      .then(() => toast("🔗 Link copied!"))
      .catch(() => toast("Link: " + url));
  } else {
    toast("Link: " + url);
  }
}
(window as any).shareStory = shareStory;

/* ════════════════════════════════════════
   FILTERS
════════════════════════════════════════ */
function setFilter(f: string, btn: HTMLElement): void {
  S.filter = f;
  document.querySelectorAll(".f-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  renderMarkers(); renderFeed();
}
(window as any).setFilter = setFilter;

/* ════════════════════════════════════════
   HEATMAP
════════════════════════════════════════ */
let _heatLayer: any = null;

function buildHeatLayer(): any {
  const stories = S.stories.filter((s: any) => s.lat && s.lng);
  if (!stories.length) return null;
  const points = stories.map((s: any) => [s.lat, s.lng, 1.0]);
  return L.heatLayer(points, {
    radius:  35,
    blur:    25,
    maxZoom: 12,
    max:     1.0,
    gradient: { 0.2: "#0d2b4e", 0.4: "#0a4a6e", 0.6: "#4dffb4", 0.8: "#ffd760", 1.0: "#ff6b35" },
  });
}

function toggleHeat(btn: HTMLElement): void {
  const isOn = btn.classList.toggle("on");
  if (isOn) {
    _heatLayer = buildHeatLayer();
    if (_heatLayer) {
      _heatLayer.addTo(map);
      S.markers.forEach((m: any) => m.setOpacity(0.15));
      toast("🌡 Heatmap ON");
    } else {
      btn.classList.remove("on");
      toast("⚠ Chưa có story nào để hiển thị heatmap");
    }
  } else {
    if (_heatLayer) { map.removeLayer(_heatLayer); _heatLayer = null; }
    S.markers.forEach((m: any) => m.setOpacity(1));
    toast("🌡 Heatmap OFF");
  }
}
(window as any).toggleHeat = toggleHeat;

function refreshHeatIfOn(): void {
  const btn = document.getElementById("heatBtn");
  if (!btn?.classList.contains("on")) return;
  if (_heatLayer) map.removeLayer(_heatLayer);
  _heatLayer = buildHeatLayer();
  if (_heatLayer) _heatLayer.addTo(map);
}
(window as any).refreshHeatIfOn = refreshHeatIfOn;

function locateMe(): void {
  map.locate({ setView: true, maxZoom: 14 });
  map.once("locationfound", (e: any) => {
    L.circle(e.latlng, { radius: e.accuracy, color: "#4dffb4", fillOpacity: .08, weight: 1 }).addTo(map);
    toast("📍 Location found!");
  });
  map.once("locationerror", () => toast("⚠ Could not find location"));
}
(window as any).locateMe = locateMe;

/* ════════════════════════════════════════
   UI HELPERS
════════════════════════════════════════ */
function toggleFeed(): void {
  const sidebar       = document.getElementById("sidebar")!;
  const geoSearchWrap = document.getElementById("geoSearchWrap");
  sidebar.classList.toggle("open");
  if (window.innerWidth <= 768 && geoSearchWrap) {
    geoSearchWrap.classList.toggle("hide-mobile", sidebar.classList.contains("open"));
  }
}
(window as any).toggleFeed = toggleFeed;

function openModal(id: string): void  { document.getElementById(id)?.classList.add("show"); }
function closeModal(id: string): void { document.getElementById(id)?.classList.remove("show"); }
(window as any).openModal  = openModal;
(window as any).closeModal = closeModal;

function overlayClick(e: MouseEvent, id: string): void {
  if ((e.target as HTMLElement).id === id) closeModal(id);
}
(window as any).overlayClick = overlayClick;

/* ════════════════════════════════════════
   IMAGE DRAG & DROP
════════════════════════════════════════ */
const imgDrop = document.getElementById("imgDrop")!;
imgDrop.addEventListener("dragover", e => { e.preventDefault(); imgDrop.classList.add("drag"); });
imgDrop.addEventListener("dragleave", () => imgDrop.classList.remove("drag"));
imgDrop.addEventListener("drop", e => {
  e.preventDefault(); imgDrop.classList.remove("drag");
  const file = (e as DragEvent).dataTransfer?.files[0];
  if (file && file.type.startsWith("image/")) {
    if (file.size > 5 * 1024 * 1024) { toast("⚠ Image max 5MB"); return; }
    const r = new FileReader();
    r.onload = ev => {
      S.imgData = (ev.target as FileReader).result as string;
      const p = document.getElementById("imgPreview") as HTMLImageElement;
      p.src = S.imgData; p.style.display = "block";
    };
    r.readAsDataURL(file);
  }
});

/* ════════════════════════════════════════
   KEYBOARD SHORTCUTS
════════════════════════════════════════ */
document.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Escape") {
    document.querySelectorAll(".overlay.show").forEach(el => closeModal(el.id));
    if (S.picking) cancelPick();
  }
  if (e.key === "f" && !["INPUT","TEXTAREA"].includes((e.target as HTMLElement).tagName)) toggleFeed();
  if (e.key === "n" && !["INPUT","TEXTAREA"].includes((e.target as HTMLElement).tagName)) startPost();
  if (e.key === "r" && !["INPUT","TEXTAREA"].includes((e.target as HTMLElement).tagName)) refreshFromShelby();
});

/* ════════════════════════════════════════
   GEO-SEARCH
════════════════════════════════════════ */
(function initGeoSearch() {
  const wrap = document.createElement("div");
  wrap.id = "geoSearchWrap";
  wrap.innerHTML = `
    <div id="geoSearchBox">
      <span class="geo-search-icon">🔍</span>
      <input id="geoSearchInput" type="text"
             placeholder="Search place, address, coords…"
             autocomplete="off" spellcheck="false" />
      <button class="geo-search-clear" id="geoSearchClear" title="Clear">✕</button>
      <span class="geo-kbd">/ to focus</span>
    </div>
    <div id="geoResults"></div>
  `;
  document.body.appendChild(wrap);

  const input    = document.getElementById("geoSearchInput")  as HTMLInputElement;
  const results  = document.getElementById("geoResults")!;
  const clearBtn = document.getElementById("geoSearchClear")!;

  let _debTimer:    ReturnType<typeof setTimeout> | null = null;
  let _selectedIdx  = -1;
  let _items: any[] = [];
  let _flyMarker:   any = null;

  document.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "/" && !["INPUT","TEXTAREA"].includes((e.target as HTMLElement).tagName)) {
      e.preventDefault(); input.focus(); input.select();
    }
    if (e.key === "Escape" && document.activeElement === input) {
      closeResults(); input.blur();
    }
  });

  input.addEventListener("input", () => {
    const q = input.value.trim();
    clearBtn.classList.toggle("vis", q.length > 0);
    _selectedIdx = -1;
    if (_debTimer) clearTimeout(_debTimer);
    if (!q) { closeResults(); return; }
    _debTimer = setTimeout(() => doSearch(q), 380);
  });

  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (!results.classList.contains("open")) return;
    if (e.key === "ArrowDown") { e.preventDefault(); moveSelect(1); }
    if (e.key === "ArrowUp")   { e.preventDefault(); moveSelect(-1); }
    if (e.key === "Enter")     {
      e.preventDefault();
      if (_selectedIdx >= 0 && _items[_selectedIdx]) geoFlyTo(_items[_selectedIdx]);
      else if (_items[0]) geoFlyTo(_items[0]);
    }
  });

  clearBtn.addEventListener("click", () => {
    input.value = ""; clearBtn.classList.remove("vis");
    closeResults(); input.focus();
    if (_flyMarker) { map.removeLayer(_flyMarker); _flyMarker = null; }
  });

  document.addEventListener("click", (e: Event) => {
    if (!wrap.contains(e.target as Node)) closeResults();
  });

  function closeResults(): void {
    results.classList.remove("open");
    results.innerHTML = "";
    _items = []; _selectedIdx = -1;
  }

  function moveSelect(dir: number): void {
    const rows = results.querySelectorAll(".geo-result-item");
    rows.forEach(r => r.classList.remove("selected"));
    _selectedIdx = Math.max(0, Math.min(_items.length - 1, _selectedIdx + dir));
    (rows[_selectedIdx] as HTMLElement)?.classList.add("selected");
    (rows[_selectedIdx] as HTMLElement)?.scrollIntoView({ block: "nearest" });
  }

  async function doSearch(q: string): Promise<void> {
    const coordMatch = q.match(/^(-?\d+\.?\d*)\s*[,\s]\s*(-?\d+\.?\d*)$/);
    if (coordMatch) {
      const lat = parseFloat(coordMatch[1]), lng = parseFloat(coordMatch[2]);
      if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        renderItems([{
          display_name: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
          name: "Custom Coordinates",
          lat: String(lat), lon: String(lng),
          _isCoord: true,
        }]);
        return;
      }
    }

    showLoading();
    try {
      const url  = `https://geostory-0wfq.onrender.com/api/geocode/search?q=${encodeURIComponent(q)}&limit=6`;
      const res  = await fetch(url);
      const data = await res.json();
      if (!data.length) { showEmpty(q); return; }
      renderItems(data);
    } catch {
      showEmpty(q, true);
    }
  }

  function showLoading(): void {
    results.innerHTML = `<div class="geo-status"><div class="geo-spin"></div>SEARCHING...</div>`;
    results.classList.add("open");
  }
  function showEmpty(q: string, isErr = false): void {
    results.innerHTML = `<div class="geo-status">${isErr ? "⚠ Network error" : `No results for "${q}"`}</div>`;
    results.classList.add("open");
  }

  function renderItems(data: any[]): void {
    _items = data;
    results.innerHTML = data.map((item, i) => {
      const name    = item.name || item.display_name.split(",")[0];
      const detail  = item._isCoord ? "Custom pin" : item.display_name;
      const lat     = parseFloat(item.lat).toFixed(3);
      const lng     = parseFloat(item.lon).toFixed(3);
      const typeIcon = getTypeIcon(item.type || item.class || "");
      const qRaw    = input.value.trim();
      const hiName  = name.replace(
        new RegExp(`(${qRaw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"),
        "<mark>$1</mark>"
      );
      return `
        <div class="geo-result-item" data-idx="${i}">
          <div class="geo-result-pin">${typeIcon}</div>
          <div class="geo-result-body">
            <div class="geo-result-name">${hiName}</div>
            <div class="geo-result-detail">${detail}</div>
          </div>
          <div class="geo-result-coords">${lat}<br>${lng}</div>
        </div>`;
    }).join("");

    results.classList.add("open");

    results.querySelectorAll(".geo-result-item").forEach(row => {
      row.addEventListener("click", () => {
        const idx = parseInt((row as HTMLElement).dataset.idx!);
        geoFlyTo(_items[idx]);
      });
      row.addEventListener("mouseenter", () => {
        results.querySelectorAll(".geo-result-item").forEach(r => r.classList.remove("selected"));
        row.classList.add("selected");
        _selectedIdx = parseInt((row as HTMLElement).dataset.idx!);
      });
    });
  }

  function geoFlyTo(item: any): void {
    const lat  = parseFloat(item.lat);
    const lng  = parseFloat(item.lon);
    const name = item.name || item.display_name.split(",")[0];

    if (_flyMarker) { map.removeLayer(_flyMarker); _flyMarker = null; }
    map.flyTo([lat, lng], 14, { duration: 1.4, easeLinearity: 0.3 });

    const markerEl = document.createElement("div");
    markerEl.className = "geo-fly-marker";
    markerEl.innerHTML = `
  <div style="
    display:inline-flex;align-items:center;justify-content:center;gap:6px;
    background:var(--accent);color:var(--bg);
    font-family:'IBM Plex Mono',monospace;font-size:0.6rem;font-weight:700;line-height:1;
    padding:6px 10px;border-radius:999px;white-space:nowrap;max-width:160px;overflow:hidden;
    box-shadow:0 4px 16px rgba(77,255,180,0.45);">
    <span style="display:flex;align-items:center;justify-content:center;width:12px;height:12px;line-height:12px;font-size:10px;flex-shrink:0;">📍</span>
    <span style="overflow:hidden;text-overflow:ellipsis;">${name.slice(0,22)}${name.length > 22 ? "…" : ""}</span>
  </div>`;

    _flyMarker = L.marker([lat, lng], {
      icon: L.divIcon({ html: markerEl.outerHTML, className: "", iconAnchor: [0, 32] }),
      zIndexOffset: 1000,
    }).addTo(map);

    input.value = name;
    clearBtn.classList.add("vis");
    closeResults();
    toast(`Flew to ${name}`);
  }

  function getTypeIcon(type: string): string {
    const t = type.toLowerCase();
    if (/restaurant|food|cafe|bar/.test(t))     return "🍜";
    if (/hotel|hostel|motel/.test(t))            return "🏨";
    if (/airport|aerodrome/.test(t))             return "✈";
    if (/park|garden|nature|forest/.test(t))     return "🌿";
    if (/museum|art|gallery/.test(t))            return "🎨";
    if (/beach|coast|sea/.test(t))               return "🏖";
    if (/mountain|peak|hill/.test(t))            return "⛰";
    if (/city|town|village|place/.test(t))       return "🏙";
    if (/church|temple|mosque|shrine/.test(t))   return "⛩";
    if (/hospital|clinic/.test(t))               return "🏥";
    if (/school|university|college/.test(t))     return "🏫";
    return "📍";
  }
})();

/* ════════════════════════════════════════
   AI TRAVEL COMPANION
════════════════════════════════════════ */
const _aiHistory: { role: string; text: string }[] = [];

function toggleAI(): void {
  const panel = document.getElementById("aiPanel")!;
  const btn   = document.getElementById("aiBtn")!;
  const open  = panel.classList.toggle("open");
  btn.classList.toggle("open", open);
  if (open) _aiUpdateLocation();
}
(window as any).toggleAI = toggleAI;

function _aiUpdateLocation(): void {
  const c     = map.getCenter();
  const locEl = document.getElementById("aiLoc");

  fetch(`https://geostory-0wfq.onrender.com/api/geocode/reverse?lat=${c.lat}&lon=${c.lng}`)
    .then(r => {
      if (!r.ok) throw new Error("geocode " + r.status);
      return r.json();
    })
    .then(d => {
      const name = d.address?.city
        || d.address?.town
        || d.address?.village
        || d.address?.county
        || d.address?.state
        || d.display_name?.split(",")[0]
        || null;
      (window as any)._aiPlaceName = name;
      if (locEl) locEl.textContent = "📍 " + (name || "—");
    })
    .catch(() => {});
}

function getDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180)
    * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function _aiDetectCategory(text: string): string | null {
  const t = text.toLowerCase();
  if (/food|eat|ăn|ẩm thực|đặc sản|món|nhà hàng|quán|restaurant|cuisine|dish|meal|snack|coffee|cà phê/.test(t)) return "food";
  if (/adventure|phiêu lưu|leo núi|hiking|trek|climb|waterfall|thác|rừng|jungle|outdoor|extreme/.test(t)) return "adventure";
  if (/art|nghệ thuật|mural|painting|gallery|triển lãm|graffiti|sculpture/.test(t)) return "art";
  if (/nature|thiên nhiên|landscape|cảnh vật|forest|rừng|beach|biển|mountain|núi|sunset|sunrise|bình minh|hoàng hôn/.test(t)) return "nature";
  if (/travel|du lịch|tour|trip|journey|chuyến đi|destination|điểm đến/.test(t)) return "travel";
  if (/photo|photograph|chụp ảnh|picture|shot|selfie|ảnh/.test(t)) return "photo";
  return null;
}

async function aiSend(): Promise<void> {
  const input = document.getElementById("aiInput") as HTMLInputElement;
  const text  = input.value.trim();
  if (!text) return;
  input.value = "";

  const quickEl = document.getElementById("aiQuick");
  if (quickEl) quickEl.style.display = "none";

  _aiAddMsg(text, "user");
  _aiAddTyping();

  try {
    const center = map.getCenter();

    const zoom     = map.getZoom();
    const radiusKm = zoom >= 12 ? 10
                   : zoom >= 8  ? 50
                   : zoom >= 5  ? 200
                   : 500;

    const detectedCat = _aiDetectCategory(text);

    const inRange = (S.stories || [])
      .filter((s: any) => getDistance(s.lat, s.lng, center.lat, center.lng) < radiusKm)
      .sort((a: any, b: any) => {
        return getDistance(a.lat, a.lng, center.lat, center.lng)
             - getDistance(b.lat, b.lng, center.lat, center.lng);
      });

    let nearby: any[];
    if (detectedCat) {
      const catMatch  = inRange.filter((s: any) => s.cat === detectedCat).slice(0, 5);
      const catOthers = inRange.filter((s: any) => s.cat !== detectedCat).slice(0, Math.max(0, 5 - catMatch.length));
      nearby = [...catMatch, ...catOthers];
    } else {
      nearby = inRange.slice(0, 5);
    }

    const nearbyPayload = nearby.map((s: any) => ({
      id:     s.id,
      title:  s.title,
      desc:   s.desc  || "",
      mood:   s.mood  || "😊",
      cat:    s.cat   || "photo",
      author: s.author || "unknown",
      lat:    s.lat,
      lng:    s.lng,
    }));

    const res = await fetch("https://geostory-0wfq.onrender.com/api/ai/companion", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        history: _aiHistory.slice(-6),
        context: {
          placeName:   (window as any)._aiPlaceName || null,
          lat:         center.lat,
          lng:         center.lng,
          nearby:      nearbyPayload,
          detectedCat: detectedCat || null,
          time:        new Date().toLocaleString("vi-VN"),
        },
      }),
    });

    const data = await res.json();
    _aiRemoveTyping();

    if (!res.ok) {
      _aiAddMsg(data.error || "An error occurred, please try again later!", "ai");
      return;
    }

    const reply = data.reply || "";
    _aiHistory.push({ role: "user",  text });
    _aiHistory.push({ role: "model", text: reply });

    _aiAddMsg(reply, "ai", nearby);

  } catch {
    _aiRemoveTyping();
    _aiAddMsg("Unable to connect to AI, please try again later!", "ai");
  }
}
(window as any).aiSend = aiSend;

function aiQuickAsk(text: string): void {
  (document.getElementById("aiInput") as HTMLInputElement).value = text;
  aiSend();
}
(window as any).aiQuickAsk = aiQuickAsk;

function _aiAddMsg(text: string, role: string, nearbyStories?: any[]): void {
  const wrap = document.getElementById("aiMessages")!;
  const div  = document.createElement("div");
  div.className = "ai-msg ai-msg--" + role;

  if (role === "ai") {
    div.innerHTML = _aiEscapeHtml(text);

    const mentioned = _aiExtractMentioned(text, nearbyStories || []);
    if (mentioned.length > 0) {
      const chipsWrap = document.createElement("div");
      chipsWrap.className = "ai-story-chips";

      mentioned.forEach((s: any) => {
        const full = (S.stories || []).find((x: any) => x.id === s.id) || s;

        const chip = document.createElement("button");
        chip.className = "ai-story-chip";
        chip.innerHTML = `
          <span class="ai-chip-cat">${(CAT_EMOJI && CAT_EMOJI[s.cat]) || "📍"}</span>
          <span class="ai-chip-title">${_aiEscapeHtml(s.title)}</span>
          <span class="ai-chip-badge">${_aiEscapeHtml(s.cat)}</span>
          <span class="ai-chip-arrow">→</span>
        `;
        chip.onclick = () => {
          if ((window as any)._globeWrap?.classList.contains("active")) exitGlobe();
          map.flyTo([s.lat, s.lng], 14, { duration: 1.2 });
          map.once("moveend", () => showPopup(full));
        };
        chipsWrap.appendChild(chip);
      });

      div.appendChild(chipsWrap);
    }
  } else {
    div.textContent = text;
  }

  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
}

function _aiExtractMentioned(replyText: string, nearbyStories: any[]): any[] {
  if (!nearbyStories?.length) return [];
  const lower = replyText.toLowerCase();
  const found: any[] = [];

  for (const s of nearbyStories) {
    if (found.length >= 3) break;
    const title = (s.title || "").toLowerCase().trim();
    if (title.length >= 3 && lower.includes(title)) found.push(s);
  }

  if (found.length === 0) return nearbyStories.slice(0, 3);
  return found;
}

function _aiEscapeHtml(str: string): string {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function _aiAddTyping(): void {
  const wrap = document.getElementById("aiMessages")!;
  const div  = document.createElement("div");
  div.className = "ai-msg ai-msg--ai";
  div.id        = "aiTyping";
  div.innerHTML = '<div class="ai-typing"><span></span><span></span><span></span></div>';
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
}

function _aiRemoveTyping(): void {
  document.getElementById("aiTyping")?.remove();
}

let _geocodeTimer: ReturnType<typeof setTimeout> | null = null;
map.on("moveend", () => {
  if (!document.getElementById("aiPanel")?.classList.contains("open")) return;
  if (_geocodeTimer) clearTimeout(_geocodeTimer);
  _geocodeTimer = setTimeout(_aiUpdateLocation, 800);
});

/* ════════════════════════════════════════
   EXPOSE
════════════════════════════════════════ */
(window as any).loadStoriesFromShelby     = loadStoriesFromShelby;
(window as any).loadUserStoriesFromShelby = loadUserStories;

/* ════════════════════════════════════════
   BOOT
════════════════════════════════════════ */
if (SERVER_ACCOUNT) {
  _autoLoadPromise = new Promise<void>(resolve => {
    setTimeout(async () => {
      toast("⏳ Loading stories from Shelby...");
      try {
        const res  = await fetch("https://geostory-0wfq.onrender.com/api/stories");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = JSON.parse(await res.text());
        if (Array.isArray(data.stories) && data.stories.length) {
          const walletAddr = S.walletAddr ?? "";
          const stories    = data.stories.map((s: any) => {
            const story = normalizeStory(s, SERVER_ACCOUNT);
            if (walletAddr) story.isOwn = story.fullAddr?.toLowerCase() === walletAddr.toLowerCase();
            return story;
          });
          const existing = new Set(S.stories.map((x: any) => x.id));
          const fresh    = stories.filter((s: any) => !existing.has(s.id));
          if (fresh.length) {
            S.stories = [...fresh, ...S.stories];
            (window as any).renderMarkers?.();
            (window as any).renderFeed?.();
            syncCount();
            const n = fresh.length;
            toast(`✅ Loaded ${n} stor${n === 1 ? "y" : "ies"} from Shelby`);
            setTimeout(() => (window as any).loadLikesForStories?.(), 600);
          }
        }
      } catch (e) {
        console.warn("[GeoStory] Auto-load failed:", e);
      } finally {
        _autoLoadDone = true;
        resolve();
      }
    }, 2000);
  });
} else {
  _autoLoadDone = true;
}

setTimeout(tryAutoReconnect, 2500);

/* ════════════════════════════════════════
   START
════════════════════════════════════════ */
init();

console.log("[GeoStory] main.ts ready — wallet = identity only, upload = server");
