

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
   SUBSCRIPTIONS — pricing config (mirrors server.ts)
════════════════════════════════════════ */
// Tự động chọn backend theo môi trường đang chạy:
// - Web mở từ localhost/127.0.0.1 (đang dev/test) → gọi server local.
//   LƯU Ý: phải là http:// (không phải https://) vì Express chạy local
//   không có SSL certificate.
// - Web đã deploy thật → gọi server production trên Render.
const API_BASE = "http://localhost:3001"
/**
 * Fetch wrapper an toàn cho các endpoint trả JSON.
 *
 * Lý do cần cái này: khi Render (hoặc bất kỳ proxy/hosting nào) trả về lỗi
 * hạ tầng (cold start đánh thức server free-tier, 502/504 gateway timeout,
 * 413 payload quá lớn...), nó trả về một TRANG HTML ("<!DOCTYPE html>...")
 * chứ không phải JSON — dù server.ts của chúng ta luôn trả JSON đúng cách.
 * Gọi thẳng `res.json()` trong trường hợp đó sẽ throw:
 *   SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON
 * khiến người dùng thấy lỗi khó hiểu. Hàm này kiểm tra content-type trước,
 * và nếu không phải JSON thì tạo thông báo lỗi rõ ràng, dễ hiểu, có gợi ý
 * thử lại (vì server free-tier có thể mất 20-50s để "thức dậy").
 */
async function safeFetchJson(
  url: string,
  options?: RequestInit,
  opts?: { timeoutMs?: number }
): Promise<{ ok: boolean; status: number; data: any }> {
  const timeoutMs = opts?.timeoutMs ?? 45_000; // đủ dài cho cold start Render free tier
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, { ...options, signal: controller.signal });
  } catch (err: any) {
    clearTimeout(timer);
    if (err?.name === "AbortError") {
      throw new Error("Server không phản hồi (có thể đang khởi động lại, thử lại sau ít giây)");
    }
    throw new Error("Không thể kết nối tới server, kiểm tra lại mạng");
  }
  clearTimeout(timer);

  const contentType = res.headers.get("content-type") || "";
  const rawText = await res.text();

  // Server trả về HTML (trang lỗi của proxy/hosting) thay vì JSON
  if (!contentType.includes("application/json")) {
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new Error("Server đang khởi động lại (cold start), vui lòng thử lại sau 20-30 giây");
    }
    if (res.status === 413) {
      throw new Error("Dữ liệu gửi lên quá lớn (ảnh quá nặng), vui lòng chọn ảnh nhỏ hơn");
    }
    if (res.status === 429) {
      throw new Error("Quá nhiều yêu cầu, vui lòng thử lại sau ít phút");
    }
    console.error("[safeFetchJson] non-JSON response:", res.status, rawText.slice(0, 300));
    throw new Error(`Server trả về phản hồi không hợp lệ (mã lỗi ${res.status}), vui lòng thử lại`);
  }

  let data: any;
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch (err) {
    console.error("[safeFetchJson] JSON parse failed:", rawText.slice(0, 300));
    throw new Error("Server trả về dữ liệu không hợp lệ, vui lòng thử lại");
  }

  return { ok: res.ok, status: res.status, data };
}

// Payment collected in APT (testnet) for now — will switch to shelbyUSD later.
const TREASURY_ADDRESS = "0x2a2b71eb64838441b6bb408913cacd6d04f517fac1e187f7c346931f35b32775";
const OCTAS_PER_APT    = 100_000_000;

type TierName = "free" | "pro" | "premium";

const PRICING: Record<Exclude<TierName, "free">, { apt: number; days: number; aiCreditsPerDay: number | null }> = {
  pro:     { apt: 5,  days: 30, aiCreditsPerDay: 20 },
  premium: { apt: 15, days: 30, aiCreditsPerDay: null },
};

const TIER_LABEL: Record<TierName, string> = { free: "Free", pro: "⭐ Pro", premium: "👑 Premium" };

// Advertiser day-pricing (mirrors server.ts AD_PRICING — draft defaults, adjust anytime)
const AD_PRICING = {
  map:  { aptPerDay: 2   },
  feed: { aptPerDay: 1.5 },
  combo: { aptPerDay: 3  },
};

// Mirrors server.ts radiusMultiplier() — wider feed reach costs more.
function radiusMultiplier(radiusKm: number): number {
  if (radiusKm <= 5)   return 1;
  if (radiusKm <= 20)  return 1.3;
  if (radiusKm <= 50)  return 1.6;
  if (radiusKm <= 100) return 2;
  return 2.5;
}
const DEFAULT_AD_RADIUS_KM = 20;

function renderTierBadge(tier?: string | null): string {
  if (tier === "pro")     return `<span class="tier-badge tier-badge--pro">⭐ PRO</span>`;
  if (tier === "premium") return `<span class="tier-badge tier-badge--premium">👑 PREMIUM</span>`;
  return "";
}

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
  tier:          TierName;
  tierExpiresAt: number | null;
  showAds:       boolean;
  adLat:         number | null;
  adLng:         number | null;
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
  tier:          "free",
  tierExpiresAt: null,
  showAds:       true,
  adLat:         null,
  adLng:         null,
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

const TILE_URL_DARK  = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
const TILE_URL_LIGHT = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";

let _mapTileLayer = L.tileLayer(TILE_URL_DARK, {
  maxZoom: 19,
  noWrap: false,
}).addTo(map);

L.control.zoom({ position: "topright" }).addTo(map);

/* ════════════════════════════════════════
   THEME — light / dark toggle
════════════════════════════════════════ */
function applyTheme(theme: "dark" | "light"): void {
  if (theme === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  map.removeLayer(_mapTileLayer);
  _mapTileLayer = L.tileLayer(theme === "light" ? TILE_URL_LIGHT : TILE_URL_DARK, {
    maxZoom: 19,
    noWrap: false,
  }).addTo(map);
  const btn = document.getElementById("themeToggleBtn");
  if (btn) btn.textContent = theme === "light" ? "☀" : "🌙";
  localStorage.setItem("geostory:theme", theme);
}

function toggleTheme(): void {
  const current = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
  applyTheme(current === "light" ? "dark" : "light");
}
(window as any).toggleTheme = toggleTheme;

// Restore saved preference on load (defaults to dark, matching the original look).
applyTheme(localStorage.getItem("geostory:theme") === "light" ? "light" : "dark");

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
  { name: "Hoang Sa", lat: 16.50, lng: 111.90, note: "Hoang Sa Islands" },
  { name: "Truong Sa", lat: 10.00, lng: 114.50, note: "Truong Sa Islands" },
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
          <div style="color:#4dffb4;font-size:0.75rem;font-weight:600">VIE ${island.note}</div>
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
let _pickTarget: "story" | "ad" = "story";

map.on("click", (e: any) => {
  if (!S.picking) return;
  const lat = +e.latlng.lat.toFixed(5);
  const lng = +e.latlng.lng.toFixed(5);
  hidePick();
  if (S.tempMarker) map.removeLayer(S.tempMarker);
  S.tempMarker = L.marker([lat, lng], {
    icon: L.divIcon({
      className: "",
      html: `<div class="mk" style="background:var(--accent2)">+</div>`,
      iconSize: [34, 34], iconAnchor: [17, 34],
    }),
  }).addTo(map);

  if (_pickTarget === "ad") {
    S.adLat = lat; S.adLng = lng;
    const el = document.getElementById("adCoordsTxt");
    if (el) el.textContent = `${lat}, ${lng}`;
    openModal("adModal");
  } else {
    S.lat = lat; S.lng = lng;
    (document.getElementById("coordsTxt") as HTMLElement).textContent = `${lat}, ${lng}`;
    openModal("postModal");
  }
  toast("📍 Location selected!");
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
  renderPricingModal();
  loadActiveAds();

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
  const liked = !!S.walletAddr && story.likedBy.has(S.walletAddr.toLowerCase());
  const chainBadge = story.fromChain
    ? `<div class="pop-chain-badge">⛓ ON-CHAIN · SHELBYNET</div>` : "";
  const cmtCount = Array.isArray(story.commentList) ? story.commentList.length : (story.comments || 0);

  L.popup({ maxWidth: 300, className: "" })
    .setLatLng([story.lat, story.lng])
    .setContent(`
      ${imgHtml}
      <div class="pop-body">
        ${chainBadge}
        <div class="pop-title">${esc(story.mood)} ${esc(story.title)}</div>
        <div class="pop-author">${esc(story.author)} ${renderTierBadge(story.tier)} · ${timeAgo(story.time)}</div>
        <div class="pop-desc">${esc(story.desc)}</div>
        <div class="pop-tags">${tags}</div>
        <div class="pop-actions">
          <button class="pop-btn pop-btn-like${liked ? " liked" : ""}" id="poplike-${esc(story.id)}" onclick="likeStory('${esc(story.id)}')"><span class="pop-like-txt">❤ ${story.likes}</span></button>
          <button class="pop-btn pop-btn-cmt" data-id="${esc(story.id)}" onclick="openCommentModal('${esc(story.id)}')">💬 <span class="pop-cmt-num">${cmtCount}</span></button>
          <button class="pop-btn pop-btn-share" onclick="shareStory('${esc(story.id)}')">↗</button>
        </div>
      </div>`)
    .openOn(map);
}

/* ════════════════════════════════════════
   FEED
════════════════════════════════════════
   Ranking rules:
   1. A capped number of sponsored cards ("ads") always sit at the very
      top — capped so a flood of advertisers can't bury real content.
   2. Among stories: a PREMIUM author's story only jumps the queue while
      it's fresh (posted within PREMIUM_BOOST_WINDOW_MS). Older stories
      from the same premium user fall back to plain chronological order —
      the perk is "new posts get seen first", not "this person's whole
      history stays pinned forever".
   3. If there are more active ad campaigns than fit in the top slots,
      the overflow doesn't just vanish — it rotates into the top slots
      over time (so every advertiser gets fair rotation) and is also
      interleaved further down the feed every few organic cards, instead
      of stacking everything above the fold at once. */

const PREMIUM_BOOST_WINDOW_MS = 48 * 60 * 60 * 1000; // "new" = posted in the last 48h
const AD_FEED_TOP_SLOTS        = 3;                  // pinned sponsored slots at the very top
const AD_FEED_INTERLEAVE_EVERY = 8;                  // + 1 more sponsored card every N story cards
const AD_ROTATION_BUCKET_MS    = 5 * 60 * 1000;       // top-slot lineup reshuffles every 5 min

function feedSortWeight(s: any): number {
  return (s.tier === "premium" && (Date.now() - s.time) < PREMIUM_BOOST_WINDOW_MS) ? 1 : 0;
}

function sortedFeedStories(): any[] {
  return [...filtered()].sort((a: any, b: any) => {
    const wa = feedSortWeight(a), wb = feedSortWeight(b);
    if (wa !== wb) return wb - wa;   // fresh-premium first
    return b.time - a.time;          // then newest first
  });
}

/** Splits active feed ads into a rotating "top" set and a "rest" pool for
 *  interleaving, so campaigns share the spotlight fairly as volume grows. */
function rotateFeedAds(ads: any[]): { top: any[]; rest: any[] } {
  if (ads.length <= AD_FEED_TOP_SLOTS) return { top: ads, rest: [] };
  const bucket = Math.floor(Date.now() / AD_ROTATION_BUCKET_MS) % ads.length;
  const rotated = ads.slice(bucket).concat(ads.slice(0, bucket));
  return { top: rotated.slice(0, AD_FEED_TOP_SLOTS), rest: rotated.slice(AD_FEED_TOP_SLOTS) };
}

function renderFeed(): void {
  const el = document.getElementById("storyList")!;
  const { top: topAds, rest: overflowAds } = rotateFeedAds(getActiveFeedAds());
  const stories = sortedFeedStories();

  let html = topAds.map(adCardHTML).join("");

  if (overflowAds.length === 0) {
    html += stories.map(cardHTML).join("");
  } else {
    let adPtr = 0;
    stories.forEach((s, i) => {
      html += cardHTML(s);
      if ((i + 1) % AD_FEED_INTERLEAVE_EVERY === 0 && adPtr < overflowAds.length) {
        html += adCardHTML(overflowAds[adPtr]);
        adPtr++;
      }
    });
  }

  el.innerHTML = html;
}
(window as any).renderFeed = renderFeed;

function adCardHTML(ad: any): string {
  const imgPart = ad.imageBase64
    ? `<img class="scard-img" src="${esc(ad.imageBase64)}" alt="${esc(ad.title)}" loading="lazy" onerror="this.style.display='none'">`
    : `<div class="scard-img-placeholder">📢</div>`;
  const desc = esc(ad.description || "").slice(0, 100) + ((ad.description || "").length > 100 ? "..." : "");
  return `
  <div class="scard scard--ad" onclick="flyTo(${ad.lat},${ad.lng},null)">
    ${imgPart}
    <div class="scard-body">
      <div class="scard-header">
        <span class="scard-mood">📢</span>
        <div class="scard-title">${esc(ad.title)}</div>
        <span class="ad-tag">SPONSORED</span>
      </div>
      ${desc ? `<div class="scard-desc">${desc}</div>` : ""}
    </div>
  </div>`;
}

function cardHTML(s: any): string {
  const liked    = !!S.walletAddr && s.likedBy.has(S.walletAddr.toLowerCase());
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
        ${renderTierBadge(s.tier)}
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
const NETWORK        = Network.SHELBYNET;
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
  const btn   = document.getElementById("walletBtn")!;
  const label = document.getElementById("walletBtnLabel");
  if (label) label.textContent = shortAddr(addr); else btn.textContent = shortAddr(addr);
  btn.className   = "connected";
  btn.onclick     = toggleProfile;
  const profAddr = document.getElementById("profAddr");
  if (profAddr) profAddr.textContent = addr;
  fetchMyTier();
}

function clearWalletUI(): void {
  const btn   = document.getElementById("walletBtn")!;
  const label = document.getElementById("walletBtnLabel");
  if (label) label.textContent = "CONNECT WALLET"; else btn.textContent = "CONNECT WALLET";
  btn.className   = "";
  btn.onclick     = () => openModal("walletModal");
  const profAddr = document.getElementById("profAddr");
  if (profAddr) profAddr.textContent = "—";
  S.tier = "free";
  S.tierExpiresAt = null;
  S.showAds = true;
  renderPricingModal();
  updateProfileTierUI();
}

/* ════════════════════════════════════════
   SUBSCRIPTIONS — fetch tier, pay, render pricing UI
════════════════════════════════════════ */
async function fetchMyTier(): Promise<void> {
  if (!S.walletAddr) return;
  try {
    const { data } = await safeFetchJson(`${API_BASE}/api/subscribe/${S.walletAddr}`);
    S.tier          = data.tier ?? "free";
    S.tierExpiresAt = data.expiresAt ?? null;
    S.showAds       = data.showAds ?? true;
  } catch {
    S.tier = "free"; S.tierExpiresAt = null; S.showAds = true;
  }
  renderPricingModal();
  updateProfileTierUI();
  renderFeed();
  renderMarkers();
  loadActiveAds();
}

function updateTopbarTierBadge(): void {
  const el = document.getElementById("topbarTierBadge");
  if (!el) return;
  if (!S.walletAddr) { el.innerHTML = ""; return; }
  el.innerHTML = S.tier === "free"
    ? `<span class="tier-badge tier-badge--free">FREE</span>`
    : renderTierBadge(S.tier);
}

// Shared formatter for any "expires at" timestamp (subscriptions, ad campaigns).
function formatExpiry(expiresAtMs: number): { text: string; soon: boolean } {
  const now     = Date.now();
  const msLeft  = expiresAtMs - now;
  const daysLeft = Math.max(0, Math.ceil(msLeft / (24 * 60 * 60 * 1000)));
  const dateStr = new Date(expiresAtMs).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
  if (msLeft <= 0) return { text: `Expired ${dateStr}`, soon: true };
  const soon = daysLeft <= 3;
  return { text: `Expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"} (${dateStr})`, soon };
}

function updateProfileTierUI(): void {
  const el = document.getElementById("profTierBadge");
  if (el) el.innerHTML = S.tier === "free" ? "" : renderTierBadge(S.tier);
  const adsRow = document.getElementById("adsToggleRow");
  if (adsRow) adsRow.style.display = S.tier === "premium" ? "flex" : "none";
  const adsSwitch = document.getElementById("adsToggleInput") as HTMLInputElement | null;
  if (adsSwitch) adsSwitch.checked = S.showAds;

  const expiryEl = document.getElementById("profTierExpiry");
  if (expiryEl) {
    if (S.tier !== "free" && S.tierExpiresAt) {
      const { text, soon } = formatExpiry(S.tierExpiresAt);
      expiryEl.textContent = text;
      expiryEl.classList.toggle("expiry-soon", soon);
    } else {
      expiryEl.textContent = "";
      expiryEl.classList.remove("expiry-soon");
    }
  }

  updateTopbarTierBadge();
}

async function payWithAPT(tier: "pro" | "premium"): Promise<void> {
  if (!S.walletAddr) { closeModal("pricingModal"); openModal("walletModal"); return; }
  if (S.walletType !== "petra" || !_connectedWallet) {
    toast("⚠ Connect Petra wallet to upgrade — Demo mode can't sign transactions");
    return;
  }

  const btn = document.getElementById(`upgradeBtn-${tier}`) as HTMLButtonElement | null;
  const originalLabel = btn?.textContent ?? "";
  if (btn) { btn.disabled = true; btn.textContent = "⏳ Confirm in wallet..."; }

  try {
    const amountOctas = PRICING[tier].apt * OCTAS_PER_APT;

    const signFn = _connectedWallet.features["aptos:signAndSubmitTransaction"]?.signAndSubmitTransaction;
    if (!signFn) throw new Error("Wallet does not support signing transactions");

    const result = await signFn({
      payload: {
        function:      "0x1::aptos_account::transfer",
        typeArguments: [],
        functionArguments: [TREASURY_ADDRESS, String(amountOctas)],
      },
    });

    const txHash = result?.hash ?? result?.args?.hash;
    if (!txHash) throw new Error("No transaction hash returned by wallet");

    if (btn) btn.textContent = "⏳ Verifying payment...";

    const { ok, data } = await safeFetchJson(`${API_BASE}/api/subscribe`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ wallet: S.walletAddr, tier, txHash }),
    });
    if (!ok || !data.success) throw new Error(data?.error || "Activation failed");

    S.tier = data.tier;
    S.tierExpiresAt = data.expiresAt;
    toast(`✅ Upgraded to ${TIER_LABEL[data.tier as TierName]}!`);
    renderPricingModal();
    updateProfileTierUI();
    renderFeed();
    renderMarkers();
    loadActiveAds();

  } catch (err: any) {
    console.error("[payWithAPT]", err);
    toast(`❌ Payment failed: ${err?.message ?? err}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
  }
}
(window as any).payWithAPT = payWithAPT;

async function toggleAdsVisibility(checked: boolean): Promise<void> {
  if (!S.walletAddr || S.tier !== "premium") return;

  // Optimistic UI: we already have the active-campaigns list cached locally
  // (_activeAds), so there's no need to wait on the server or refetch before
  // showing/hiding — just re-render immediately from the cache. This is what
  // made the toggle feel laggy before (full network round-trip + refetch on
  // every flip). The PATCH call below still runs to persist the preference;
  // we only revert the UI if it actually fails.
  const previous = S.showAds;
  S.showAds = checked;
  renderAdMarkers();
  renderFeed();
  toast(checked ? "🔔 Ads shown" : "🔕 Ads hidden");

  try {
    const { ok, data } = await safeFetchJson(`${API_BASE}/api/settings/ads`, {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ wallet: S.walletAddr, showAds: checked }),
    });
    if (!ok) throw new Error(data?.error || "Failed to update setting");
    S.showAds = data.showAds;
  } catch (err: any) {
    // Revert — the server didn't save it, so don't leave the UI out of sync.
    S.showAds = previous;
    renderAdMarkers();
    renderFeed();
    toast(`❌ ${err?.message ?? "Could not update setting"} — reverted`);
    updateProfileTierUI(); // resync switch UI
  }
}
(window as any).toggleAdsVisibility = toggleAdsVisibility;

function renderPricingModal(): void {
  const el = document.getElementById("pricingCards");
  if (!el) return;

  const plans: { key: TierName; name: string; icon: string; price: string; sub: string; features: string[]; cta: string; highlight: boolean }[] = [
    {
      key: "free", name: "Free", icon: "🆓", price: "0", sub: "APT / forever",
      features: ["5 stories / day", "Unlimited Like & Comment", "Full map & feed access"],
      cta: "Current plan", highlight: false,
    },
    {
      key: "pro", name: "Pro", icon: "⭐", price: String(PRICING.pro.apt), sub: "APT / 30 days",
      features: ["Unlimited stories", "AI Companion — 20 messages/day", "⭐ PRO badge on map, feed & comments"],
      cta: "Upgrade to Pro", highlight: false,
    },
    {
      key: "premium", name: "Premium", icon: "👑", price: String(PRICING.premium.apt), sub: "APT / 30 days",
      features: ["Everything in Pro", "AI Companion — unlimited", "👑 PREMIUM glow badge", "Priority placement at top of feed", "Option to hide ads"],
      cta: "Upgrade to Premium", highlight: true,
    },
  ];

  el.innerHTML = plans.map(p => {
    const isCurrent = S.tier === p.key;
    const isFree    = p.key === "free";
    const btnHtml   = isCurrent
      ? `<button class="price-cta price-cta--current" disabled>✓ Current plan</button>`
      : isFree
      ? `<button class="price-cta" disabled>—</button>`
      : `<button class="price-cta" id="upgradeBtn-${p.key}" onclick="payWithAPT('${p.key}')">${p.cta}</button>`;

    // Show the real expiry date on whichever plan is currently active, if any.
    const expiryHtml = (isCurrent && !isFree && S.tierExpiresAt)
      ? `<div class="price-expiry">${esc(formatExpiry(S.tierExpiresAt).text)}</div>`
      : "";

    return `
    <div class="price-card ${p.highlight ? "price-card--highlight" : ""} ${isCurrent ? "price-card--current" : ""}">
      ${p.highlight ? `<div class="price-ribbon">MOST POPULAR</div>` : ""}
      <div class="price-icon">${p.icon}</div>
      <div class="price-name">${p.name}</div>
      <div class="price-amount"><span class="price-num">${p.price}</span><span class="price-unit">${p.sub}</span></div>
      <ul class="price-features">
        ${p.features.map(f => `<li><span class="price-check">✓</span>${esc(f)}</li>`).join("")}
      </ul>
      ${btnHtml}
      ${expiryHtml}
    </div>`;
  }).join("");
}
(window as any).renderPricingModal = renderPricingModal;

function openPricingModal(): void {
  renderPricingModal();
  openModal("pricingModal");
}
(window as any).openPricingModal = openPricingModal;

/* ════════════════════════════════════════
   ADVERTISER — create & pay for a sponsored campaign
════════════════════════════════════════ */
let _adImgData: string | null = null;
let _adPlacement: "map" | "feed" | "combo" = "map";
let _adDays = 1;
let _adRadiusKm = 5; // matches the default-selected chip in the ad modal

function openAdModal(): void {
  // Show the Ads modal (placements, pricing, campaign form) to everyone —
  // same principle as Pricing: let people see what's on offer before asking
  // them to connect a wallet. The wallet is only required at the moment
  // they actually try to submit/pay for a campaign (see submitAd()), or if
  // they switch to the "My campaigns" tab, which needs a wallet to look up.
  if (S.walletType === "demo") {
    toast("⚠ Demo mode can't sign transactions — connect Petra to advertise");
  }
  switchAdTab("create");
  openModal("adModal");
  updateAdPrice();
  _setModStatus("adModStatus", "hide");
}
(window as any).openAdModal = openAdModal;

function switchAdTab(tab: "create" | "manage"): void {
  document.querySelectorAll(".ad-tab-btn").forEach(b => b.classList.remove("sel"));
  document.getElementById(`adTab-${tab}`)?.classList.add("sel");
  const createPane = document.getElementById("adPane-create");
  const managePane = document.getElementById("adPane-manage");
  if (createPane) createPane.style.display = tab === "create" ? "block" : "none";
  if (managePane) managePane.style.display = tab === "manage" ? "block" : "none";
  if (tab === "manage") loadMyCampaigns();
}
(window as any).switchAdTab = switchAdTab;

async function loadMyCampaigns(): Promise<void> {
  const el = document.getElementById("adMyCampaigns");
  if (!el) return;
  if (!S.walletAddr) {
    el.innerHTML = `<div class="ad-empty">🔌 Connect your wallet to see your campaigns.
      <button class="ad-empty-connect-btn" onclick="openModal('walletModal')">Connect wallet</button></div>`;
    return;
  }
  el.innerHTML = `<div class="ad-empty">Loading...</div>`;
  try {
    const { data } = await safeFetchJson(`${API_BASE}/api/ads/mine/${S.walletAddr}`);
    const campaigns: any[] = Array.isArray(data.campaigns) ? data.campaigns : [];
    if (!campaigns.length) {
      el.innerHTML = `<div class="ad-empty">No campaigns yet — create your first one!</div>`;
      return;
    }
    const placementLabel: Record<string, string> = { map: "📍 Map Pin", feed: "📰 Feed", combo: "✦ Map + Feed" };
    el.innerHTML = campaigns.map(ad => {
      const endDateStr = new Date(ad.endAt).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
      const endTimeStr = new Date(ad.endAt).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
      const radiusPart = (ad.placement === "feed" || ad.placement === "combo") && ad.radiusKm
        ? ` · ${ad.radiusKm}km reach`
        : "";
      return `
      <div class="ad-my-card ${ad.active ? "" : "ad-my-card--expired"}">
        <div class="ad-my-head">
          <span class="ad-my-title">${esc(ad.title)}</span>
          <span class="ad-my-status ${ad.active ? "ad-my-status--active" : "ad-my-status--expired"}">
            ${ad.active ? `🟢 ${ad.daysLeft} day${ad.daysLeft === 1 ? "" : "s"} left` : "⚪ Ended"}
          </span>
        </div>
        <div class="ad-my-meta">${placementLabel[ad.placement] ?? ad.placement} · ${ad.days} day${ad.days > 1 ? "s" : ""} campaign${radiusPart}</div>
        <div class="ad-my-meta">${ad.active ? "Expires" : "Expired"} ${endDateStr} at ${endTimeStr}</div>
      </div>
    `; }).join("");
  } catch {
    el.innerHTML = `<div class="ad-empty">Could not load your campaigns, please try again.</div>`;
  }
}
(window as any).loadMyCampaigns = loadMyCampaigns;

function handleAdImg(e: Event): void {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { toast("⚠ Image max 5MB"); return; }
  const reader = new FileReader();
  reader.onload = ev => {
    _adImgData = (ev.target as FileReader).result as string;
    const p = document.getElementById("adImgPreview") as HTMLImageElement;
    if (p) { p.src = _adImgData; p.style.display = "block"; }
    document.getElementById("adImgDrop")?.classList.add("has-image");
  };
  reader.readAsDataURL(file);
}
(window as any).handleAdImg = handleAdImg;

function pickAdPlacement(btn: HTMLElement): void {
  _adPlacement = btn.dataset.placement as "map" | "feed" | "combo";
  document.querySelectorAll(".ad-placement-chip").forEach(c => c.classList.remove("sel"));
  btn.classList.add("sel");
  const radiusGroup = document.getElementById("adRadiusGroup");
  if (radiusGroup) radiusGroup.style.display = (_adPlacement === "feed" || _adPlacement === "combo") ? "flex" : "none";
  updateAdPrice();
}
(window as any).pickAdPlacement = pickAdPlacement;

function pickAdRadius(btn: HTMLElement): void {
  _adRadiusKm = Number(btn.dataset.radius) || DEFAULT_AD_RADIUS_KM;
  document.querySelectorAll(".ad-radius-chip").forEach(c => c.classList.remove("sel"));
  btn.classList.add("sel");
  updateAdPrice();
}
(window as any).pickAdRadius = pickAdRadius;

function pickAdDays(btn: HTMLElement): void {
  const custom = document.getElementById("adDaysCustom") as HTMLInputElement | null;
  if (btn.dataset.days === "custom") {
    if (custom) { custom.style.display = "inline-block"; custom.focus(); }
    _adDays = custom && +custom.value > 0 ? +custom.value : 1;
  } else {
    if (custom) custom.style.display = "none";
    _adDays = Number(btn.dataset.days);
  }
  document.querySelectorAll(".ad-days-chip").forEach(c => c.classList.remove("sel"));
  btn.classList.add("sel");
  updateAdPrice();
}
(window as any).pickAdDays = pickAdDays;

function onAdDaysCustomInput(input: HTMLInputElement): void {
  const n = Math.max(1, Math.min(365, Math.floor(Number(input.value) || 1)));
  input.value = String(n);
  _adDays = n;
  updateAdPrice();
}
(window as any).onAdDaysCustomInput = onAdDaysCustomInput;

function updateAdPrice(): void {
  const hasRadius  = _adPlacement === "feed" || _adPlacement === "combo";
  const mult       = hasRadius ? radiusMultiplier(_adRadiusKm) : 1;
  const perDayBase = AD_PRICING[_adPlacement].aptPerDay;
  const perDay     = +(perDayBase * mult).toFixed(2);
  const total      = +(perDay * _adDays).toFixed(2);
  const el = document.getElementById("adPriceTotal");
  if (el) el.textContent = `${total} APT`;
  const subEl = document.getElementById("adPriceSub");
  if (subEl) {
    subEl.textContent = hasRadius
      ? `${perDay} APT/day × ${_adDays} day${_adDays > 1 ? "s" : ""} · ${_adRadiusKm}km reach (×${mult})`
      : `${perDay} APT/day × ${_adDays} day${_adDays > 1 ? "s" : ""}`;
  }
}
(window as any).updateAdPrice = updateAdPrice;

function _setModStatus(elId: string, state: "checking" | "ok" | "rejected" | "hide", text?: string): void {
  const el = document.getElementById(elId);
  if (!el) return;
  if (state === "hide") {
    el.className = "mod-status";
    el.textContent = "";
    return;
  }
  el.className = `mod-status show mod-status--${state}`;
  el.textContent = text ?? (
    state === "checking" ? "The AI ​​is moderating the content, please wait..." :
    state === "ok"       ? "Valid content - processing..." :
                            "Invalid content."
  );
}

async function submitAd(): Promise<void> {
  const title = (document.getElementById("adTitle") as HTMLInputElement).value.trim();
  const desc  = (document.getElementById("adDesc")  as HTMLTextAreaElement).value.trim();

  if (!title) { toast("⚠ Please enter a campaign title"); return; }
  if (S.adLat == null || S.adLng == null) { toast("📍 Click the map to pick a location"); startAdPick(); return; }
  if (!_connectedWallet) { toast("⚠ Connect Petra wallet to advertise"); return; }

  const btn = document.getElementById("adSubmitBtn") as HTMLButtonElement | null;
  const originalLabel = btn?.textContent ?? "";
  if (btn) { btn.disabled = true; }

  try {
    // ── AI moderation, checked BEFORE the wallet is ever asked to sign a
    // payment — so a rejected campaign never costs the advertiser APT.
    if (btn) btn.textContent = "⏳ AI is moderating content...";
    _setModStatus("adModStatus", "checking");

    const { ok: modOk, data: modData } = await safeFetchJson(`${API_BASE}/api/ads/moderate`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, description: desc, imageBase64: _adImgData ?? undefined }),
    }, { timeoutMs: 30_000 });

    if (!modOk) {
      _setModStatus("adModStatus", "rejected", modData?.error || "Content violates community guidelines, please revise the title/description/image.");
      toast(`❌ ${modData?.error ?? "Content rejected by AI moderation"}`);
      return;
    }
    _setModStatus("adModStatus", "ok");

    const hasRadius   = _adPlacement === "feed" || _adPlacement === "combo";
    const mult        = hasRadius ? radiusMultiplier(_adRadiusKm) : 1;
    const amountOctas = Math.round(AD_PRICING[_adPlacement].aptPerDay * mult * _adDays * OCTAS_PER_APT);

    if (btn) btn.textContent = "⏳ Confirm in wallet...";

    const signFn = _connectedWallet.features["aptos:signAndSubmitTransaction"]?.signAndSubmitTransaction;
    if (!signFn) throw new Error("Wallet does not support signing transactions");

    const result = await signFn({
      payload: {
        function:      "0x1::aptos_account::transfer",
        typeArguments: [],
        functionArguments: [TREASURY_ADDRESS, String(amountOctas)],
      },
    });

    const txHash = result?.hash ?? result?.args?.hash;
    if (!txHash) throw new Error("No transaction hash returned by wallet");

    if (btn) btn.textContent = "⏳ Verifying payment...";

    const { ok, data } = await safeFetchJson(`${API_BASE}/api/ads`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wallet: S.walletAddr, title, description: desc,
        imageBase64: _adImgData ?? undefined,
        lat: S.adLat, lng: S.adLng,
        placement: _adPlacement, radiusKm: hasRadius ? _adRadiusKm : undefined, days: _adDays, txHash,
      }),
    }, { timeoutMs: 60_000 }); // dài hơn vì có thể kèm ảnh base64
    if (!ok || !data.success) {
      if (data?.categories) _setModStatus("adModStatus", "rejected", data?.error);
      throw new Error(data?.error || "Campaign activation failed");
    }

    _setModStatus("adModStatus", "hide");
    toast("✅ Campaign is live!");
    closeModal("adModal");
    if (S.tempMarker) { map.removeLayer(S.tempMarker); S.tempMarker = null; }
    loadActiveAds();

    // reset form
    (document.getElementById("adTitle") as HTMLInputElement).value = "";
    (document.getElementById("adDesc")  as HTMLTextAreaElement).value = "";
    _adImgData = null;
    S.adLat = null; S.adLng = null;
    const preview = document.getElementById("adImgPreview") as HTMLImageElement | null;
    if (preview) preview.style.display = "none";
    document.getElementById("adImgDrop")?.classList.remove("has-image");
    const coordsEl = document.getElementById("adCoordsTxt");
    if (coordsEl) coordsEl.textContent = "Not selected";
    _adRadiusKm = DEFAULT_AD_RADIUS_KM;
    document.querySelectorAll(".ad-radius-chip").forEach(c =>
      (c as HTMLElement).classList.toggle("sel", (c as HTMLElement).dataset.radius === "5"));

  } catch (err: any) {
    console.error("[submitAd]", err);
    toast(`❌ Campaign failed: ${err?.message ?? err}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
  }
}
(window as any).submitAd = submitAd;

/* ── Rendering sponsored content on map + feed ── */
let _activeAds: any[] = [];
let _adMarkers: any[] = [];

async function loadActiveAds(): Promise<void> {
  try {
    const qs  = S.walletAddr ? `?wallet=${encodeURIComponent(S.walletAddr)}` : "";
    const { data } = await safeFetchJson(`${API_BASE}/api/ads/active${qs}`);
    _activeAds = Array.isArray(data.campaigns) ? data.campaigns : [];
  } catch {
    _activeAds = [];
  }
  renderAdMarkers();
  renderFeed();
}

function renderAdMarkers(): void {
  _adMarkers.forEach(m => map.removeLayer(m));
  _adMarkers = [];

  // Premium wallets can opt out of seeing ads (S.showAds) — enforced
  // client-side now so the toggle is instant (see toggleAdsVisibility()).
  if (!S.showAds) return;

  for (const ad of _activeAds) {
    if (ad.placement !== "map" && ad.placement !== "combo") continue;
    const icon = L.divIcon({
      className: "",
      html: `
        <div class="ad-pin-wrap">
          <div class="ad-pin-pulse"></div>
          <div class="ad-pin"><span class="ad-pin-icon">📢</span></div>
        </div>
      `,
      iconSize: [40, 46], iconAnchor: [20, 46],
    });
    const marker = L.marker([ad.lat, ad.lng], { icon }).addTo(map);
    marker.bindPopup(`
      <div class="pop-card">
        ${ad.imageBase64 ? `<img class="pop-img" src="${ad.imageBase64}">` : ""}
        <div class="pop-title">📢 ${esc(ad.title)}</div>
        <div class="pop-author"><span class="ad-tag">SPONSORED</span></div>
        <div class="pop-desc">${esc(ad.description)}</div>
      </div>
    `, { className: "custom-popup" });
    _adMarkers.push(marker);
  }
}
(window as any).loadActiveAds = loadActiveAds;

function getActiveFeedAds(): any[] {
  if (!S.showAds) return [];
  const center = map.getCenter();
  return _activeAds.filter(ad => {
    if (ad.placement !== "feed" && ad.placement !== "combo") return false;
    const radiusKm = Number(ad.radiusKm) || DEFAULT_AD_RADIUS_KM;
    // Only shown in the feed to viewers currently looking at the map within
    // the campaign's paid-for reach radius.
    return getDistance(ad.lat, ad.lng, center.lat, center.lng) <= radiusKm;
  });
}

// Feed ad relevance depends on what part of the map the viewer is looking at
// (radius targeting), so re-check it whenever the view settles — debounced
// so dragging the map doesn't hammer renderFeed().
let _feedAdMoveTimer: ReturnType<typeof setTimeout> | null = null;
map.on("moveend", () => {
  if (_feedAdMoveTimer) clearTimeout(_feedAdMoveTimer);
  _feedAdMoveTimer = setTimeout(() => renderFeed(), 400);
});


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
    sep.textContent    = "SHELBYNET";
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
      // Ngay sau khi ví vừa approve (re)connect — đặc biệt là reconnect trong
      // cùng phiên trang ngay sau disconnect — một số extension chưa kịp
      // đồng bộ xong network state nội bộ, nên lần đọc network() đầu tiên có
      // thể trả về giá trị cũ dù ví thực tế đã ở đúng mạng. Reload trang chỉ
      // "sửa" được vì extension inject lại state mới từ đầu. Ta giả lập điều
      // đó bằng cách retry vài lần với delay ngắn trước khi coi là lệch mạng
      // thật sự.
      let net = await networkFn();
      let attempts = 0;
      while (net?.name?.toLowerCase() !== "shelbynet" && attempts < 4) {
        await delay(300);
        net = await networkFn();
        attempts++;
      }
      if (net?.name?.toLowerCase() !== "shelbynet") {
        toast(`⚠ Please switch ${wallet.name} to Shelbynet`);
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
      if (net?.name?.toLowerCase() !== "shelbynet") {
        toast(`⚠ ${wallet.name} has left Shelbynet`);
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
  S.stories.forEach((s: any) => { s.isOwn = false; });
  clearWalletUI();
  const card = document.getElementById("profileCard");
  if (card) card.style.display = "none";
  const profStories = document.getElementById("profStories");
  const profLikes   = document.getElementById("profLikes");
  if (profStories) profStories.textContent = "0";
  if (profLikes)   profLikes.textContent   = "0";
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
  if (!S.walletAddr) {
    toast("🔌 Connect a wallet to view your profile");
    openModal("walletModal");
    return;
  }
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
  _setModStatus("storyModStatus", "hide");
}
(window as any).startPost = startPost;

function startPick(): void {
  closeModal("postModal");
  _pickTarget = "story";
  S.picking = true;
  document.getElementById("pickBar")!.classList.add("show");
  map.getContainer().style.cursor = "crosshair";
}
(window as any).startPick = startPick;

function startAdPick(): void {
  closeModal("adModal");
  _pickTarget = "ad";
  S.picking = true;
  document.getElementById("pickBar")!.classList.add("show");
  map.getContainer().style.cursor = "crosshair";
}
(window as any).startAdPick = startAdPick;

function hidePick(): void {
  S.picking = false;
  document.getElementById("pickBar")!.classList.remove("show");
  map.getContainer().style.cursor = "";
}

function cancelPick(): void {
  hidePick();
  openModal(_pickTarget === "ad" ? "adModal" : "postModal");
}
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
    document.getElementById("imgDrop")?.classList.add("has-image");
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
  _setModStatus("storyModStatus", "checking", "AI is moderating content before it's published...");

  try {
    if (!(window as any).shelby) {
      btn.textContent = "⏳ Connecting to Shelby...";
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("main.ts not loaded yet, please reload the page")), 5000);
        window.addEventListener("shelby:ready", () => { clearTimeout(t); resolve(undefined); }, { once: true });
      });
    }
    btn.textContent = "🤖 AI is moderating content...";
    const shelbyAPI = (window as any).shelby;
    const result = await shelbyAPI.upload({
      title, desc, image: S.imgData,
      lat: S.lat, lng: S.lng, mood: S.mood, cat: S.cat,
      wallet: S.walletAddr,
    });
    _setModStatus("storyModStatus", "ok", "Valid content — saving to Shelby...");
    btn.textContent = "⏳ Uploading to Shelby...";

    const story = {
      // Dùng chính id mà server đã sinh và lưu trữ (result.id), không tự tạo
      // id cục bộ nữa — để link share và trạng thái like luôn khớp với dữ
      // liệu thật trên server sau khi reload trang.
      id: result.id,
      title, desc,
      lat: S.lat, lng: S.lng,
      author:   S.walletAddr.slice(0, 8) + "..." + S.walletAddr.slice(-4),
      fullAddr: S.walletAddr,
      mood: S.mood, cat: S.cat, tags: [S.cat],
      likes: 0, comments: 0, time: Date.now(),
      tier: S.tier,
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
    document.getElementById("imgDrop")?.classList.remove("has-image");
    (document.getElementById("imgFile")   as HTMLInputElement).value = "";
    (document.getElementById("coordsTxt") as HTMLElement).textContent = "Not selected";
    document.querySelectorAll(".mood-opt").forEach(b =>
      (b as HTMLElement).classList.toggle("sel", (b as HTMLElement).dataset.mood === "😊"));
    document.querySelectorAll(".cat-chip").forEach(c =>
      (c as HTMLElement).classList.toggle("sel", (c as HTMLElement).dataset.cat === "photo"));
    if (S.tempMarker) { map.removeLayer(S.tempMarker); S.tempMarker = null; }

    prog.classList.remove("show");
    btn.disabled = false; btn.textContent = "✦ PUBLISH TO SHELBY";
    _setModStatus("storyModStatus", "hide");
    closeModal("postModal");

    const cidShort = result.cid.slice(0, 28) + "...";
    toast(`✅ Story published on-chain!\n${cidShort}`);
    map.flyTo([story.lat, story.lng], 14, { duration: 2 });

  } catch (err: any) {
    console.error("[GeoStory] submitStory error:", err);
    prog.classList.remove("show");
    btn.disabled = false; btn.textContent = "✦ PUBLISH TO SHELBY";
    if (err?.status === 422) {
      // Rejected by AI moderation — surface it inline under the button,
      // not just as a passing toast, so it doesn't get missed.
      _setModStatus("storyModStatus", "rejected", err?.message || "Content violates community guidelines, please revise the title/description/image.");
    } else {
      _setModStatus("storyModStatus", "hide");
      toast(`❌ Upload failed: ${err?.message ?? err}`);
    }
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
  }): Promise<{ id: string; cid: string; txHash?: string; imageUrl?: string }> => {

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

    const res = await fetch(`${API_BASE}/api/stories`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
    });

    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch {
      throw new Error(`Server error ${res.status} — response is not JSON: ${text.slice(0, 120)}`);
    }
    if (!res.ok || !json.success) {
      const err: any = new Error(json.error ?? `Upload failed (${res.status})`);
      err.status = res.status;
      err.categories = json.categories;
      throw err;
    }
    // QUAN TRỌNG: phải trả về đúng `id` mà server đã sinh và lưu (json.id),
    // KHÔNG được để caller tự bịa id riêng — nếu không thì link share
    // (?story=<id>) và like (POST /api/stories/:id/like) sẽ được lưu dưới
    // một id "ảo" chỉ tồn tại phía client, còn khi load lại từ server
    // (GET /api/stories) thì story lại có id do server sinh, khác hẳn ⇒ link
    // share bị "not found" và like bị mất khi reload.
    return { id: json.id, cid: json.blobName, txHash: undefined, imageUrl: json.imageUrl };
  },
};

/* ════════════════════════════════════════
   LOAD STORIES
════════════════════════════════════════ */
export async function loadStoriesFromShelby(accountAddress: string): Promise<any[]> {
  try {
    const res  = await fetch(`${API_BASE}/api/stories`);
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
    tier:      data.tier        ?? "free",
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
    // NOTE: previously capped at the newest 20 stories — any story outside
    // that window kept the default empty likedBy Set from normalizeStory(),
    // so the like button could never show as "already liked" for it even if
    // the connected wallet genuinely liked it before. Now we hydrate ALL
    // loaded on-chain stories (still chunked so we don't fire everything in
    // parallel).
    const targets = S.stories.filter((s: any) => s.fromChain);
    if (!targets.length) return;

    const CHUNK = 5;
    for (let i = 0; i < targets.length; i += CHUNK) {
      const batch = targets.slice(i, i + CHUNK);
      await Promise.allSettled(
        batch.map(async (s: any) => {
          try {
            const ctrl  = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 4000);
            const r     = await fetch(`${API_BASE}/api/stories/${s.id}/likes`, { signal: ctrl.signal });
            clearTimeout(timer);
            if (!r.ok) return;
            const data  = await r.json();
            s.likes     = typeof data.count === "number" ? data.count : 0;
            // Normalize to lowercase so wallet-address casing differences
            // (e.g. between wallet providers/sessions) never cause a story
            // the user already liked to render as "not liked".
            s.likedBy   = new Set(
              (Array.isArray(data.likedBy) ? data.likedBy : []).map((w: string) => (w || "").toLowerCase())
            );
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

// Chặn double-submit: nếu 1 lượt like/unlike cho story này đang gửi lên
// server (chưa có phản hồi), bỏ qua các lượt bấm tiếp theo cho tới khi xong.
// Vẫn giữ optimistic UI update (đổi tim/số đếm ngay) nhưng không bắn thêm
// request — tránh lãng phí gas và giảm race condition phía server.
const _pendingLikes = new Set<string>();

async function likeStory(id: string): Promise<void> {
  if (!S.walletAddr) { toast("Connect wallet to like"); return; }
  if (_pendingLikes.has(id)) return;

  const s = S.stories.find((x: any) => x.id === id);
  if (!s) return;

  const myWallet = S.walletAddr.toLowerCase();
  const alreadyLiked = s.likedBy.has(myWallet);
  if (alreadyLiked) { s.likedBy.delete(myWallet); s.likes = Math.max(0, s.likes - 1); }
  else              { s.likedBy.add(myWallet);    s.likes++; }

  _updateLikeButtons(s);
  renderFeed();

  if (!s.fromChain || S.walletAddr.startsWith("0xDEMO")) {
    toast(alreadyLiked ? "💔 Unliked" : "❤ Liked!");
    return;
  }

  _pendingLikes.add(id);
  _setLikePending(id, true);
  try {
    const r = await fetch(`${API_BASE}/api/stories/${id}/like`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ wallet: S.walletAddr }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error ?? "Like failed");

    s.likes   = data.count ?? s.likes;
    s.likedBy = new Set(
      (Array.isArray(data.likedBy) ? data.likedBy : [...s.likedBy]).map((w: string) => (w || "").toLowerCase())
    );
    _updateLikeButtons(s);
    renderFeed();

    toast(data.action === "liked" ? "❤ Liked!" : "💔 Unliked");
  } catch (err: any) {
    if (alreadyLiked) { s.likedBy.add(myWallet); s.likes++; }
    else              { s.likedBy.delete(myWallet); s.likes = Math.max(0, s.likes - 1); }
    renderFeed();
    toast("⚠ Could not save like: " + (err?.message ?? err));
    console.error("[GeoStory] likeStory error:", err);
  } finally {
    _pendingLikes.delete(id);
    _setLikePending(id, false);
  }
}
(window as any).likeStory = likeStory;

function _updateLikeButtons(s: any): void {
  const liked = !!S.walletAddr && s.likedBy.has(S.walletAddr.toLowerCase());
  const cardBtn = document.getElementById(`card-like-${s.id}`);
  if (cardBtn) {
    cardBtn.querySelector(".rxn-num")!.textContent = s.likes;
    cardBtn.classList.toggle("liked", !!liked);
  }
  const popBtn = document.getElementById(`poplike-${s.id}`);
  if (popBtn) {
    const txt = popBtn.querySelector(".pop-like-txt");
    if (txt) txt.textContent = `❤ ${s.likes}`;
    popBtn.classList.toggle("liked", !!liked);
  }
}

// Bật/tắt hiệu ứng loading (spinner) trên nút like trong lúc request đang
// chạy — áp dụng cho cả bản trên card lẫn bản trong popup bản đồ, vì cùng
// 1 story có thể đang hiển thị ở cả 2 nơi cùng lúc.
function _setLikePending(id: string, pending: boolean): void {
  document.getElementById(`card-like-${id}`)?.classList.toggle("like-pending", pending);
  document.getElementById(`poplike-${id}`)?.classList.toggle("like-pending", pending);
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
    const r     = await fetch(`${API_BASE}/api/stories/${storyId}/comments`, { signal: ctrl.signal });
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
        ${renderTierBadge(c.tier)}
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
    const r = await fetch(`${API_BASE}/api/stories/${storyId}/comments`, {
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
    btn.textContent = "↑ SEND";
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
      toast("⚠ No stories available to show on heatmap yet");
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
      document.getElementById("imgDrop")?.classList.add("has-image");
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
      const url = `${API_BASE}/api/geocode/search?q=${encodeURIComponent(q)}&limit=6`;
      const { data } = await safeFetchJson(url);
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

  fetch(`${API_BASE}/api/geocode/reverse?lat=${c.lat}&lon=${c.lng}`)
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

  if (!S.walletAddr) {
    _aiAddMsg(text, "user");
    input.value = "";
    _aiAddMsg("🔒 Please connect your wallet to chat with the AI Companion.", "ai");
    const quickEl = document.getElementById("aiQuick");
    if (quickEl) quickEl.style.display = "none";
    setTimeout(() => openModal("walletModal"), 900);
    return;
  }

  if (S.tier === "free") {
    _aiAddMsg(text, "user");
    input.value = "";
    _aiAddMsg("🔒 AI Companion is a Pro/Premium feature. Upgrade to unlock unlimited local insights!", "ai");
    const quickEl = document.getElementById("aiQuick");
    if (quickEl) quickEl.style.display = "none";
    setTimeout(() => openPricingModal(), 900);
    return;
  }

  input.value = "";

  const quickEl = document.getElementById("aiQuick");
  if (quickEl) quickEl.style.display = "none";

  _aiAddMsg(text, "user");
  _aiAddTyping();

  try {
    const center = map.getCenter();

    const zoom = map.getZoom();
    // Kept intentionally tight — this list is meant to read as "right around
    // where you're asking about", not "somewhere in the same region". It used
    // to scale up to 200-500km when the map was zoomed out, which meant
    // chatting about, say, Hải Phòng while the map was zoomed out could pull
    // in stories from Hưng Yên or further — technically "on screen" but not
    // remotely what "nearby" should mean. Capped hard at 35km now, even at
    // the widest zoom levels.
    const radiusKm = zoom >= 13 ? 5
                   : zoom >= 11 ? 10
                   : zoom >= 9  ? 20
                   : 35; // hard cap regardless of how zoomed out the map is

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

    const { ok, data } = await safeFetchJson(`${API_BASE}/api/ai/companion`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        history: _aiHistory.slice(-6),
        wallet:  S.walletAddr,
        context: {
          placeName:   (window as any)._aiPlaceName || null,
          lat:         center.lat,
          lng:         center.lng,
          nearby:      nearbyPayload,
          nearbyRadiusKm: radiusKm,
          detectedCat: detectedCat || null,
          time:        new Date().toLocaleString("vi-VN"),
        },
      }),
    }, { timeoutMs: 60_000 }); // AI có thể mất thời gian phản hồi lâu hơn

    _aiRemoveTyping();

    if (!ok) {
      _aiAddMsg(data?.error || "An error occurred, please try again later!", "ai");
      if (data?.upgradeRequired) setTimeout(() => openPricingModal(), 900);
      return;
    }

    const reply = data.reply || "";
    _aiHistory.push({ role: "user",  text });
    _aiHistory.push({ role: "model", text: reply });

    // Sponsored slot: the nearest active feed/combo ad within reach of where
    // the person is asking, if any — prioritized as suggestion #1.
    // getActiveFeedAds() already filters to ads whose paid reach radius
    // covers the current map center, so we just need the closest one.
    const nearestAd = [...getActiveFeedAds()]
      .sort((a: any, b: any) => getDistance(a.lat, a.lng, center.lat, center.lng) - getDistance(b.lat, b.lng, center.lat, center.lng))[0] || null;

    _aiAddMsg(reply, "ai", nearby, nearestAd);

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

const AI_MAX_SUGGESTIONS = 3;

function _aiOpenAdPopup(ad: any): void {
  const html = `
    <div class="pop-card">
      ${ad.imageBase64 ? `<img class="pop-img" src="${ad.imageBase64}">` : ""}
      <div class="pop-title">📢 ${esc(ad.title)}</div>
      <div class="pop-author"><span class="ad-tag">SPONSORED</span></div>
      <div class="pop-desc">${esc(ad.description)}</div>
    </div>`;
  L.popup({ className: "custom-popup" }).setLatLng([ad.lat, ad.lng]).setContent(html).openOn(map);
}

function _aiAddMsg(text: string, role: string, nearbyStories?: any[], nearestAd?: any | null): void {
  const wrap = document.getElementById("aiMessages")!;
  const div  = document.createElement("div");
  div.className = "ai-msg ai-msg--" + role;

  if (role === "ai") {
    div.innerHTML = _aiEscapeHtml(text);

    // Max 3 suggestions total: 1 sponsored ad slot (closest active feed ad,
    // if any) prioritized first, then up to 2 stories matching the question.
    const storySlots = nearestAd ? AI_MAX_SUGGESTIONS - 1 : AI_MAX_SUGGESTIONS;
    const mentioned  = _aiExtractMentioned(text, nearbyStories || []).slice(0, storySlots);

    if (mentioned.length > 0 || nearestAd) {
      const chipsWrap = document.createElement("div");
      chipsWrap.className = "ai-story-chips";

      if (nearestAd) {
        const chip = document.createElement("button");
        chip.className = "ai-story-chip ai-story-chip--ad";
        chip.innerHTML = `
          <span class="ai-chip-cat">📢</span>
          <span class="ai-chip-title">${_aiEscapeHtml(nearestAd.title)}</span>
          <span class="ai-chip-badge ai-chip-badge--sponsored">Sponsored</span>
          <span class="ai-chip-arrow">→</span>
        `;
        chip.onclick = () => {
          if ((window as any)._globeWrap?.classList.contains("active")) exitGlobe();
          map.flyTo([nearestAd.lat, nearestAd.lng], 14, { duration: 1.2 });
          map.once("moveend", () => _aiOpenAdPopup(nearestAd));
        };
        chipsWrap.appendChild(chip);
      }

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
        const res  = await fetch(`${API_BASE}/api/stories`);
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
