/* ════════════════════════════════════════
   HELPERS
════════════════════════════════════════ */
const esc = s => s == null ? '' : String(s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/\"/g,'&quot;').replace(/'/g,'&#039;');

const delay = ms => new Promise(r => setTimeout(r, ms));

function timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 60000)    return 'just now';
  if (d < 3600000)  return Math.floor(d/60000)   + 'm ago';
  if (d < 86400000) return Math.floor(d/3600000)  + 'h ago';
  return Math.floor(d/86400000) + 'd ago';
}

const CAT_EMOJI  = { photo:'📷', adventure:'⛰', food:'🍜', art:'🎨', travel:'✈', nature:'🌿' };
const MOOD_COLOR = { '🤩':'#ffd760','😊':'#4dffb4','😌':'#88ccff','🤔':'#ffae5c','😢':'#74b9ff','🔥':'#ff6b35' };

/* ════════════════════════════════════════
   STATE
════════════════════════════════════════ */
const S = {
  walletAddr: null,
  walletType: null,   // 'petra' | 'demo' | 'metamask'
  stories: [],
  markers: [],
  filter: 'all',
  picking: false,
  lat: null, lng: null,
  mood: '😊',
  cat: 'photo',
  imgData: null,
  tempMarker: null,
  shelbyLoading: false,
};
window.S = S;

/* ════════════════════════════════════════
   MAP
════════════════════════════════════════ */
const map = L.map('map', {
  center: [15, 100],
  zoom: 4,
  zoomControl: false,
  attributionControl: false,
  worldCopyJump: true,
  minZoom: 3,
});

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  maxZoom: 19,
  noWrap: false,
}).addTo(map);

L.control.zoom({ position: 'topright' }).addTo(map);

/* ════════════════════════════════════════
   GLOBE
════════════════════════════════════════ */
(function setupGlobe() {
  const wrap = document.createElement('div');
  wrap.id = 'globe-wrap';
  wrap.innerHTML = `
    <canvas id="globe-canvas"></canvas>
    <div id="globe-hint">DRAG TO ROTATE  ·  SCROLL UP TO ZOOM IN</div>
    <button id="globe-enter" onclick="exitGlobe()">↗ ENTER MAP</button>
  `;
  document.body.appendChild(wrap);
  window._globeWrap = wrap;
})();

const GC = {
  canvas: null, ctx: null,
  w: 0, h: 0, r: 0,
  rotX: 0.25, rotY: 1.85,
  dragging: false,
  lastX: 0, lastY: 0,
  velX: 0, velY: 0,
  raf: null,
  stars: [],
};

function _buildStars(w, h) {
  GC.stars = Array.from({ length: 240 }, (_, i) => ({
    x: ((i * 7919 + 13) % w),
    y: ((i * 6271 + 7)  % h),
    r: (i % 3 === 0) ? 1.2 : 0.6,
    a: 0.25 + (i % 7) * 0.11,
  }));
}

function initGlobe() {
  GC.canvas = document.getElementById('globe-canvas');
  GC.ctx    = GC.canvas.getContext('2d');
  _resizeGlobe();

  GC.canvas.addEventListener('mousedown', e => {
    GC.dragging = true; GC.lastX = e.clientX; GC.lastY = e.clientY;
    GC.velX = GC.velY = 0; e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!GC.dragging) return;
    const dx = e.clientX - GC.lastX, dy = e.clientY - GC.lastY;
    GC.velY = dx * 0.005; GC.velX = dy * 0.005;
    GC.rotY += GC.velY; GC.rotX += GC.velX;
    GC.rotX = Math.max(-1.4, Math.min(1.4, GC.rotX));
    GC.lastX = e.clientX; GC.lastY = e.clientY;
  });
  window.addEventListener('mouseup', () => { GC.dragging = false; });

  GC.canvas.addEventListener('touchstart', e => {
    GC.dragging = true;
    GC.lastX = e.touches[0].clientX; GC.lastY = e.touches[0].clientY;
    GC.velX = GC.velY = 0; e.preventDefault();
  }, { passive: false });
  window.addEventListener('touchmove', e => {
    if (!GC.dragging) return;
    const dx = e.touches[0].clientX - GC.lastX, dy = e.touches[0].clientY - GC.lastY;
    GC.rotY += dx * 0.005; GC.rotX += dy * 0.005;
    GC.rotX = Math.max(-1.4, Math.min(1.4, GC.rotX));
    GC.lastX = e.touches[0].clientX; GC.lastY = e.touches[0].clientY;
  });
  window.addEventListener('touchend', () => { GC.dragging = false; });

  GC.canvas.addEventListener('wheel', e => {
    if (e.deltaY < 0) exitGlobe();
    e.preventDefault();
  }, { passive: false });

  window.addEventListener('resize', _resizeGlobe);
  _drawGlobe();
}

function _resizeGlobe() {
  GC.w = window.innerWidth;
  GC.h = window.innerHeight;
  GC.r = Math.min(GC.w, GC.h) * 0.40;
  GC.canvas.width  = GC.w;
  GC.canvas.height = GC.h;
  _buildStars(GC.w, GC.h);
}

function _project(latR, lngR) {
  const x0 = Math.cos(latR) * Math.sin(lngR);
  const y0 = Math.sin(latR);
  const z0 = Math.cos(latR) * Math.cos(lngR);
  const y1 = y0 * Math.cos(GC.rotX) - z0 * Math.sin(GC.rotX);
  const z1 = y0 * Math.sin(GC.rotX) + z0 * Math.cos(GC.rotX);
  const x2 =  x0 * Math.cos(GC.rotY) + z1 * Math.sin(GC.rotY);
  const z2 = -x0 * Math.sin(GC.rotY) + z1 * Math.cos(GC.rotY);
  return { x: x2, y: y1, visible: z2 > 0 };
}

function _drawGlobe() {
  if (!GC.ctx) return;
  const { ctx, w, h, r, stars } = GC;
  const cx = w / 2, cy = h / 2;
  ctx.clearRect(0, 0, w, h);

  const bgG = ctx.createRadialGradient(cx, cy, r * 0.4, cx, cy, r * 1.8);
  bgG.addColorStop(0, '#080d1a'); bgG.addColorStop(1, '#03050e');
  ctx.fillStyle = bgG; ctx.fillRect(0, 0, w, h);

  ctx.save();
  stars.forEach(s => {
    ctx.globalAlpha = s.a; ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
  });
  ctx.restore();

  // Quả địa cầu nền
  const darkG = ctx.createRadialGradient(cx - r*.28, cy - r*.25, r*.08, cx, cy, r);
  darkG.addColorStop(0, 'rgba(10,20,50,0.97)');
  darkG.addColorStop(.55, 'rgba(5,10,28,0.98)');
  darkG.addColorStop(1,   'rgba(2,4,10,1)');
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = darkG; ctx.fill();

  // Lưới kinh vĩ tuyến mờ
  ctx.save(); ctx.strokeStyle = 'rgba(77,255,180,0.04)'; ctx.lineWidth = .5;
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

  // Đường bờ biển thật
  _drawCoastlines(ctx, cx, cy, r);

  // Story dots — render rõ hơn với ring ngoài
  S.stories.forEach(s => {
    const p = _project(s.lat * Math.PI / 180, s.lng * Math.PI / 180);
    if (!p.visible) return;
    const px = cx + p.x * r, py = cy - p.y * r;
    const col = MOOD_COLOR[s.mood] || '#4dffb4';
    ctx.save();
    // Glow
    ctx.globalAlpha = 0.35;
    ctx.beginPath(); ctx.arc(px, py, 9, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 14; ctx.fill();
    // Dot chính
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.fill();
    // Ring
    ctx.globalAlpha = 0.7;
    ctx.beginPath(); ctx.arc(px, py, 5.5, 0, Math.PI * 2);
    ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.stroke();
    ctx.restore();
  });

  // Ánh sáng viền cầu
  const lightG = ctx.createRadialGradient(cx - r*.4, cy - r*.38, 0, cx, cy, r);
  lightG.addColorStop(0, 'rgba(80,140,255,.07)');
  lightG.addColorStop(.5,'rgba(77,255,180,.025)');
  lightG.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = lightG; ctx.fill();

  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(77,255,180,.22)'; ctx.lineWidth = 1.5; ctx.stroke();

  if (!GC.dragging) {
    GC.velX *= .93; GC.velY *= .93;
    GC.rotX += GC.velX; GC.rotY += GC.velY;
    GC.rotY += 0.0007;
  }
  GC.raf = requestAnimationFrame(_drawGlobe);
}

// ── Quần đảo Hoàng Sa & Trường Sa ──────────────────────────────────────────
const VN_ISLANDS = [
  { name: 'Hoang Sa', lat: 16.50, lng: 111.90, note: 'Hoang Sa Islands(Viet Nam)' },
  { name: 'Truong Sa', lat: 10.00, lng: 114.50, note: 'Truong Sa Islands(Viet Nam)' },
];

function addVietnamIslandMarkers() {
  VN_ISLANDS.forEach(island => {
    const icon = L.divIcon({
      className: '',
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

// ── Globe: dữ liệu bờ biển đơn giản hóa ────────────────────────────────────
// Mảng các polygon/polyline [lat, lng] đại diện cho đường bờ biển các lục địa chính
// Được lấy từ Natural Earth simplified (110m resolution) rút gọn thủ công
const COASTLINES = (() => {
  // Dữ liệu bờ biển được mã hóa theo định dạng [[lat,lng],...]
  // Mỗi mảng con là 1 segment bờ biển liên tục
  const raw = [
    // Châu Á - Đông Nam Á - Việt Nam khu vực
    [[1.3,103.8],[1.4,104.1],[1.7,103.6],[1.3,103.8]],
    [[5.3,100.3],[5.5,100.4],[5.8,100.5],[6.0,100.3],[5.3,100.3]],
    // Bán đảo Đông Dương
    [[10.0,104.5],[10.5,104.8],[11.0,104.7],[11.5,104.9],[12.0,104.8],[12.5,104.5],
     [13.0,104.2],[13.5,103.8],[14.0,103.5],[14.5,103.8],[15.0,104.0],[15.5,108.5],
     [16.0,108.3],[16.5,107.8],[17.0,107.2],[17.5,106.8],[18.0,106.5],[18.5,106.0],
     [19.0,105.8],[19.5,106.0],[20.0,106.3],[20.5,106.8],[21.0,107.5],[21.3,108.2],
     [20.9,107.0],[20.5,106.5],[20.0,106.1],[19.5,105.8],[19.0,105.6],[18.5,105.9],
     [17.5,106.5],[16.5,107.5],[15.9,108.4],[15.5,108.9],[14.8,109.2],[13.8,109.3],
     [12.8,109.2],[11.8,109.0],[11.0,108.5],[10.5,107.5],[10.0,104.5]],
    // Thái Lan + Malaysia peninsula
    [[1.3,103.8],[2.0,103.9],[3.0,103.5],[4.0,103.4],[5.0,102.9],[6.0,102.2],
     [7.0,101.5],[8.0,100.5],[9.0,99.8],[10.0,99.0],[11.0,99.5],[12.0,100.1],
     [13.0,100.6],[13.7,100.5]],
    // Myanmar coast
    [[10.0,98.5],[11.0,98.8],[12.0,98.5],[13.0,98.2],[14.0,98.0],[15.0,97.8],
     [16.0,97.5],[17.0,97.3],[18.0,97.0],[19.0,96.8],[20.0,96.9]],
    // Trung Quốc bờ biển
    [[20.0,110.5],[21.0,110.8],[22.0,111.5],[23.0,116.7],[24.0,117.5],
     [25.0,119.5],[26.0,119.9],[27.0,120.8],[28.0,121.5],[29.0,122.0],
     [30.0,122.3],[31.0,121.8],[32.0,121.5],[33.0,120.8],[34.0,120.3],
     [35.0,119.5],[36.0,120.5],[37.0,122.5],[38.0,121.5],[39.0,121.8],
     [40.0,122.5],[41.0,121.0]],
    // Nhật Bản (Honshu)
    [[31.5,131.0],[32.0,131.5],[33.0,132.0],[34.0,134.0],[35.0,136.8],
     [36.0,136.5],[37.0,137.0],[38.0,141.0],[39.0,141.8],[40.0,141.5],
     [41.0,141.0],[42.0,140.5],[43.0,141.4],[44.0,144.0],[43.0,145.0],
     [42.0,143.5],[41.0,140.8],[40.5,140.5]],
    // Hàn Quốc
    [[34.5,126.0],[35.0,126.5],[35.5,129.4],[36.0,129.6],[37.0,129.4],
     [37.5,126.6],[37.0,126.2],[36.5,126.3],[35.5,126.5],[35.0,126.3]],
    // Philippines (Luzon)
    [[14.5,121.0],[15.0,120.0],[16.0,119.8],[17.0,120.3],[18.0,122.0],
     [17.0,122.5],[16.0,122.3],[15.0,121.8],[14.5,121.0]],
    // Indonesia (Sumatra west)
    [[5.5,95.3],[4.5,95.6],[3.5,96.0],[2.5,96.2],[1.5,98.8],[0.5,99.5],
     [-0.5,100.3],[-1.5,100.8],[-2.5,101.5],[-3.5,102.3],[-4.5,103.5],
     [-5.5,105.5],[-5.9,105.9]],
    // India
    [[8.0,77.5],[9.0,77.5],[10.0,76.9],[11.0,75.5],[12.0,74.8],[13.0,74.8],
     [14.0,74.5],[15.0,73.9],[16.0,73.5],[17.0,73.3],[18.0,73.1],[19.0,72.8],
     [20.0,72.8],[21.0,69.2],[22.0,68.8],[23.0,68.4],[23.5,68.3],
     [22.5,70.2],[22.0,72.6],[21.0,72.4],[20.0,72.8]],
    [[8.0,77.5],[9.0,79.0],[10.0,80.3],[11.0,79.9],[12.0,80.3],[13.0,80.2],
     [14.0,80.0],[15.0,80.2],[16.0,80.3],[17.0,82.3],[18.0,84.1],[19.0,85.1],
     [20.0,86.5],[21.0,87.0],[22.0,88.0]],
    // Sri Lanka
    [[9.8,80.3],[8.5,81.2],[6.0,80.2],[7.5,79.9],[9.8,80.3]],
    // Châu Phi
    [[37.3,10.0],[36.8,11.0],[37.0,11.2],[37.3,10.0]],
    [[35.0,-5.0],[35.5,-5.3],[36.0,-5.5],[37.0,-5.0],[37.5,-0.5],
     [37.0,4.0],[35.0,11.0],[33.0,12.5],[32.0,11.5],[31.0,10.0],
     [30.5,9.8],[31.3,9.5],[30.0,9.3]],
    // Đông Phi
    [[-11.7,40.5],[-10.0,40.5],[-8.0,39.5],[-6.0,39.3],[-4.0,39.7],
     [-2.0,40.9],[0,41.5],[2,41.0],[4,41.5],[5,44.0],[8,48.0],
     [10,51.0],[11,51.5],[12,44.5],[11,43.3],[12,43.0],[11.5,42.5]],
    // Afrika Selatan
    [[-34.8,19.9],[-34.4,26.5],[-33.0,28.0],[-31.0,30.0],[-29.0,31.0],
     [-26.0,33.0],[-24.0,35.0],[-22.0,35.5],[-20.0,35.0],[-18.0,37.0],
     [-16.0,39.5],[-14.0,40.5],[-12.0,40.5]],
    [[-34.8,19.9],[-33.0,18.0],[-31.0,17.5],[-29.0,16.8],[-27.0,15.5],
     [-25.0,15.0],[-22.0,14.3],[-19.0,12.3],[-17.0,11.8],[-15.0,12.0],
     [-13.0,12.5],[-11.0,14.0],[-10.0,16.0]],
    // Tây Phi
    [[15.0,-17.5],[14.0,-17.0],[13.0,-16.5],[12.0,-15.0],[11.0,-15.0],
     [10.0,-14.0],[9.0,-13.5],[8.0,-13.0],[7.0,-11.5],[6.0,-10.0],
     [5.0,-5.0],[4.5,-2.5],[4.0,1.5],[5.0,3.0],[6.0,3.5],[4.0,8.0],
     [3.0,9.5],[2.0,9.7],[1.0,9.3],[0,2.0],[0,-1.0]],
    // Bắc Phi - Địa Trung Hải
    [[37.0,-8.5],[36.5,-7.0],[36.0,-5.5],[36.4,-4.5],[36.7,-3.5],
     [37.0,-1.5],[37.5,1.0],[37.2,4.0],[36.8,5.0],[37.0,7.5],
     [37.5,9.5],[37.3,10.5],[37.0,11.0]],
    [[31.5,32.0],[31.0,32.5],[30.5,32.3],[30.0,32.5],[29.0,34.8],
     [28.0,34.5],[27.0,34.0],[25.0,37.0],[22.5,37.2],[21.0,37.0]],
    // Châu Âu - Tây Ban Nha / Bồ Đào Nha
    [[36.0,-5.5],[37.0,-7.0],[38.0,-8.0],[39.0,-9.5],[40.0,-8.8],
     [41.5,-8.8],[42.0,-8.9],[43.0,-9.3],[43.5,-8.5],[44.0,-8.3],
     [43.4,-1.8],[43.0,-1.5],[42.5,-3.0],[43.0,-4.0],[43.5,-4.5],
     [43.7,-8.0]],
    [[36.0,-5.5],[36.5,-4.5],[37.0,-3.5],[38.0,-0.5],[38.5,0.5],
     [40.0,0.5],[41.0,1.5],[42.0,3.5],[43.4,4.0],[43.0,5.0],
     [43.3,5.5],[43.0,6.5],[43.7,7.5]],
    // Pháp + Ý
    [[43.7,7.5],[44.0,8.0],[43.5,10.0],[42.5,11.0],[42.0,12.0],
     [41.0,13.5],[40.0,15.0],[39.0,16.5],[38.0,15.5],[37.5,15.0],
     [37.0,15.5],[36.5,14.5],[36.8,14.0],[37.0,13.0],[37.5,12.5],
     [38.0,13.0],[38.5,13.5],[39.0,16.5]],
    // Balkan
    [[40.0,20.0],[41.0,19.5],[42.0,19.0],[42.5,18.5],[43.0,17.0],
     [44.0,15.5],[43.5,15.0],[44.5,14.5],[45.0,13.8],[44.8,13.5],
     [45.3,13.7]],
    [[40.0,22.5],[39.5,24.0],[39.0,23.0],[38.0,24.0],[37.0,23.5],
     [36.5,22.5],[37.0,21.5],[37.5,21.0],[37.0,22.0],[38.0,24.0]],
    // Yunani
    [[41.0,26.5],[40.5,27.0],[40.0,26.5],[39.0,26.5],[38.0,27.2],
     [37.5,27.0],[37.0,27.5],[36.5,29.0],[36.0,30.0],[36.5,29.5],
     [36.2,30.5],[36.0,32.0],[36.5,34.0],[37.0,36.0]],
    // Türkiye - Karadeniz + Ege
    [[37.0,36.0],[37.5,37.0],[36.5,36.5],[36.0,35.5],[36.5,34.5],
     [36.2,33.5],[36.3,32.5],[37.0,30.0],[37.5,27.5],[38.0,26.5],
     [38.5,26.8],[39.0,27.0],[40.0,27.0],[40.5,28.5],[41.0,29.0],
     [41.5,31.0],[41.3,33.0],[41.5,35.0],[42.0,38.0],[41.5,41.5]],
    // Biển Đen
    [[41.5,41.5],[42.0,43.0],[43.0,44.0],[43.5,46.5],[42.5,47.5],
     [42.0,49.0],[41.5,50.0],[41.0,49.5],[40.5,50.5],[40.0,49.5],
     [39.5,53.0],[40.0,53.5]],
    // Bán đảo Crimea
    [[45.0,36.0],[46.0,36.5],[46.5,37.5],[45.5,38.5],[45.0,37.5],[45.0,36.0]],
    // Anh quốc
    [[50.0,-5.7],[51.0,-5.0],[52.0,-5.2],[53.0,-4.5],[53.5,-3.5],
     [54.0,-3.0],[55.0,-2.0],[56.0,-2.5],[57.0,-2.0],[57.5,-4.0],
     [58.5,-3.0],[58.3,-6.2],[57.5,-7.0],[57.0,-7.5],[56.5,-6.5],
     [56.0,-5.5],[55.5,-5.3],[54.5,-5.5],[54.0,-4.8],[53.0,-4.5]],
    [[50.0,-5.7],[50.5,-1.0],[51.0,0.5],[51.5,1.5],[52.0,1.8],
     [53.0,0.5],[54.0,-0.5],[54.5,-1.0],[55.0,-1.5],[55.5,-2.0]],
    // Scandinavia
    [[57.5,8.0],[58.0,7.5],[59.0,5.5],[60.0,5.0],[61.0,5.5],
     [62.0,6.0],[63.0,8.0],[64.0,8.5],[65.0,14.0],[66.0,14.5],
     [67.0,16.0],[68.0,16.5],[69.0,18.0],[70.0,25.0],[71.0,28.0],
     [70.5,31.0],[69.5,30.5],[69.0,29.0],[68.5,28.5],[67.0,30.5],
     [66.0,29.0],[65.5,25.0],[65.0,25.5],[64.5,24.3],[63.5,22.5],
     [62.0,21.3],[60.0,19.5],[59.0,18.0],[58.5,17.0],[57.5,16.5],
     [56.5,16.0],[56.0,15.5],[55.5,14.0],[55.7,12.5],[55.5,10.5],
     [57.5,8.0]],
    // Đan Mạch + Đức bờ biển
    [[57.5,8.0],[56.5,8.5],[56.0,10.5],[57.0,10.5],[57.5,10.0],
     [57.5,8.0]],
    // Bắc Mỹ - Đường bờ biển chính
    [[70.0,-141.0],[69.0,-137.0],[68.0,-134.0],[67.0,-140.0],
     [66.0,-143.0],[65.0,-168.0],[64.0,-165.0],[63.5,-162.0],
     [64.0,-160.0],[63.0,-162.0],[62.0,-164.0],[61.0,-166.0],
     [60.0,-162.0],[59.0,-161.0],[58.0,-152.0],[57.0,-153.0],
     [56.0,-158.0],[55.0,-160.0],[54.0,-164.0],[53.5,-167.0]],
    // Alaska + BC bờ Thái Bình Dương
    [[70.0,-141.0],[69.0,-137.0],[60.0,-141.0],[59.0,-138.0],
     [58.0,-136.5],[57.0,-135.0],[56.0,-132.0],[55.0,-130.0],
     [54.0,-133.0],[53.0,-132.0],[52.0,-128.5],[51.0,-127.5],
     [50.0,-125.0],[49.0,-124.0],[48.5,-124.5]],
    // USA Tây
    [[48.5,-124.5],[47.0,-124.2],[46.0,-124.0],[45.0,-124.0],
     [44.0,-124.2],[43.0,-124.5],[42.0,-124.5],[41.0,-124.3],
     [40.0,-124.4],[39.0,-123.8],[38.0,-122.5],[37.0,-122.0],
     [36.0,-121.5],[35.0,-120.8],[34.0,-119.5],[33.0,-117.5],
     [32.5,-117.3]],
    // Mexico + Central America Bờ Thái Bình Dương
    [[32.5,-117.3],[31.0,-116.5],[30.0,-115.8],[29.0,-114.5],
     [28.0,-111.0],[27.0,-110.0],[26.0,-110.0],[25.0,-110.8],
     [24.0,-110.5],[23.0,-109.5],[22.0,-106.0],[21.0,-105.5],
     [20.0,-105.0],[19.0,-104.5],[18.0,-103.5],[17.0,-101.0],
     [16.0,-99.0],[15.0,-92.5],[14.5,-90.0],[14.0,-87.5],
     [13.0,-87.5],[12.0,-87.0],[11.0,-85.5],[10.0,-85.5],
     [9.0,-82.5],[8.5,-83.0]],
    // Central + South America Caribe
    [[8.5,-83.0],[8.0,-77.5],[9.0,-79.5],[9.5,-79.0]],
    // Colombia + Venezuela
    [[8.0,-77.5],[7.0,-77.5],[6.0,-77.0],[5.0,-77.5],[4.0,-76.5],
     [3.0,-78.5],[2.0,-80.0],[1.0,-80.0],[0,-80.0],[0,-75.5],
     [1.0,-50.0],[2.0,-50.5],[3.0,-51.5],[4.0,-52.5],[5.0,-57.0],
     [6.0,-60.0],[7.0,-61.0],[8.0,-63.0],[9.0,-63.5],[10.0,-62.5],
     [10.5,-63.0],[11.0,-74.0],[11.5,-72.5],[12.0,-71.0]],
    // Brazil bờ Đại Tây Dương
    [[1.0,-50.0],[0,-50.5],[-1.0,-48.5],[-2.0,-44.5],[-3.0,-41.5],
     [-4.0,-37.5],[-5.0,-35.0],[-8.0,-35.0],[-10.0,-37.0],
     [-12.0,-37.5],[-13.0,-39.0],[-15.0,-39.0],[-16.0,-39.5],
     [-18.0,-39.5],[-20.0,-40.5],[-22.0,-43.0],[-23.0,-44.0],
     [-24.0,-47.0],[-25.0,-48.5],[-26.0,-48.5],[-28.0,-49.0],
     [-29.0,-50.0],[-30.0,-51.0],[-31.0,-52.0],[-32.0,-52.5],
     [-33.0,-53.0],[-33.5,-53.5]],
    // Argentina + Chile
    [[-33.5,-53.5],[-34.0,-58.5],[-35.0,-57.5],[-36.0,-57.0],
     [-38.0,-57.5],[-39.0,-62.0],[-40.0,-62.5],[-41.0,-63.0],
     [-42.0,-65.0],[-43.0,-65.0],[-44.0,-66.0],[-45.0,-66.5],
     [-46.0,-67.5],[-47.0,-66.0],[-48.0,-66.0],[-50.0,-69.0],
     [-51.0,-69.0],[-52.0,-70.5],[-53.0,-71.0],[-54.0,-72.0],
     [-54.9,-65.5]],
    // Chile Thái Bình Dương
    [[-54.9,-65.5],[-54.0,-67.0],[-53.0,-74.0],[-51.0,-75.5],
     [-49.0,-75.0],[-47.0,-74.5],[-45.0,-74.0],[-43.0,-74.0],
     [-41.0,-73.5],[-39.0,-73.5],[-37.0,-73.8],[-35.0,-72.5],
     [-33.0,-71.7],[-31.0,-71.5],[-29.0,-71.3],[-27.0,-70.8],
     [-25.0,-70.7],[-23.0,-70.6],[-21.0,-70.1],[-19.0,-70.2],
     [-17.0,-71.5],[-15.0,-75.0],[-13.0,-76.5],[-11.0,-77.5],
     [-9.0,-78.5],[-7.0,-79.5],[-5.0,-81.0],[-3.0,-80.5],
     [-2.0,-81.0],[0,-80.0]],
    // Úc
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
    // New Zealand
    [[-46.5,168.5],[-45.5,167.0],[-44.5,168.0],[-43.5,172.5],
     [-42.5,171.5],[-41.5,171.5],[-40.5,172.0],[-41.0,173.5],
     [-40.5,175.0],[-39.5,176.5],[-38.5,177.5],[-37.5,178.0],
     [-37.0,175.5],[-36.5,175.0],[-37.0,174.8],[-38.0,176.0],
     [-38.5,177.5]],
    // Greenland (đơn giản)
    [[76.0,-20.0],[75.0,-18.0],[73.0,-22.0],[72.0,-25.0],[70.0,-24.0],
     [68.0,-30.0],[66.0,-35.0],[65.0,-40.0],[63.5,-42.5],[62.0,-42.0],
     [60.5,-44.5],[61.0,-48.0],[62.0,-50.0],[63.0,-52.0],[65.0,-53.0],
     [67.0,-52.0],[68.0,-55.0],[70.0,-55.0],[72.0,-57.0],[74.0,-57.5],
     [76.0,-58.0],[77.0,-62.0],[76.0,-63.5],[75.0,-60.0],[76.0,-55.0],
     [77.0,-18.0],[76.0,-20.0]],
    // Canada Đông
    [[47.0,-53.0],[47.5,-52.5],[48.5,-54.0],[49.0,-53.0],[50.0,-55.5],
     [51.0,-56.5],[52.0,-55.5],[53.0,-56.0],[54.0,-58.5],[55.0,-59.5],
     [56.0,-62.0],[57.0,-64.0],[58.0,-68.0],[59.0,-64.0],[60.0,-64.5],
     [61.0,-69.5],[62.0,-72.0],[63.0,-72.0],[64.0,-76.5],[65.0,-83.0],
     [63.0,-85.0],[61.0,-86.0],[60.0,-90.0],[59.0,-94.0],[58.0,-94.5]],
    // USA Đông
    [[47.5,-52.5],[47.0,-53.0],[46.5,-53.5],[45.5,-61.0],[44.5,-63.5],
     [43.5,-66.0],[42.0,-70.0],[41.5,-71.0],[41.0,-72.0],[40.5,-74.0],
     [39.5,-74.5],[38.5,-75.0],[37.5,-76.0],[37.0,-76.5],[36.5,-76.0],
     [35.5,-75.5],[34.5,-77.0],[33.5,-78.5],[32.5,-80.5],[31.5,-81.3],
     [30.5,-81.5],[30.0,-81.8],[29.5,-81.5],[29.0,-83.0],[28.5,-83.5],
     [28.0,-82.5],[27.5,-82.5],[27.0,-82.0],[26.5,-82.0],[26.0,-81.8],
     [25.5,-80.2],[25.0,-80.5],[25.5,-81.0]],
    // Mexico Đông + Gulf
    [[25.5,-81.0],[25.5,-80.5],[25.0,-83.5],[24.0,-84.0],[23.5,-88.0],
     [23.0,-89.5],[22.0,-90.5],[21.0,-90.0],[20.5,-90.5],[20.0,-87.5],
     [19.0,-87.5],[18.5,-88.0],[18.0,-88.5],[17.5,-88.0],[17.0,-89.0]],
    [[30.0,-88.5],[30.5,-88.5],[29.5,-89.5],[29.0,-89.5],[28.5,-90.5],
     [29.0,-90.5],[29.0,-91.5],[29.5,-93.0],[29.5,-94.5],[28.5,-96.0],
     [28.0,-97.0],[27.0,-97.5],[26.0,-97.5],[25.5,-97.5]],
    // Cuba
    [[22.0,-84.5],[22.5,-83.0],[22.0,-81.0],[22.5,-80.5],[23.0,-81.5],
     [23.5,-82.5],[22.8,-83.8],[22.5,-84.8],[22.0,-84.5]],
  ];
  return raw;
})();

function _drawCoastlines(ctx, cx, cy, r) {
  ctx.save();
  ctx.strokeStyle = 'rgba(77,180,255,0.55)';
  ctx.lineWidth   = 0.8;
  ctx.lineJoin    = 'round';

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

function showGlobe() {
  window._globeWrap.classList.add('active');
  document.getElementById('map').style.opacity = '0';
  document.getElementById('map').style.pointerEvents = 'none';
  if (!GC.canvas) initGlobe();
  if (!GC.raf)   GC.raf = requestAnimationFrame(_drawGlobe);
}

function hideGlobe() {
  window._globeWrap.classList.remove('active');
  document.getElementById('map').style.opacity = '1';
  document.getElementById('map').style.pointerEvents = '';
  if (GC.raf) { cancelAnimationFrame(GC.raf); GC.raf = null; }
}

function exitGlobe() { hideGlobe(); map.setZoom(4); }
window.exitGlobe = exitGlobe;

map.on('zoomend', () => {
  if (map.getZoom() <= 3) showGlobe();
  else hideGlobe();
});

/* ════════════════════════════════════════
   MAP CLICK — pin location
════════════════════════════════════════ */
map.on('click', e => {
  if (!S.picking) return;
  S.lat = +e.latlng.lat.toFixed(5);
  S.lng = +e.latlng.lng.toFixed(5);
  document.getElementById('coordsTxt').textContent = `${S.lat}, ${S.lng}`;
  hidePick();
  openModal('postModal');
  toast('📍 Location selected!');
  if (S.tempMarker) map.removeLayer(S.tempMarker);
  S.tempMarker = L.marker([S.lat, S.lng], {
    icon: L.divIcon({
      className: '',
      html: `<div class="mk" style="background:var(--accent2)">+</div>`,
      iconSize: [34, 34], iconAnchor: [17, 34],
    }),
  }).addTo(map);
});

/* ════════════════════════════════════════
   SEED DATA (demo/fallback)
════════════════════════════════════════ */
// const SEED = [
//   { id:'s1', title:'Sunrise at Ha Long Bay',  desc:'Mist rolling over the limestone karsts at dawn — absolutely surreal.',         lat:20.91, lng:107.18, author:'0xAb3F...71c2', mood:'🤩', cat:'nature',    tags:['nature','vietnam'],       likes:42,  comments:7,  time:Date.now()-86400000,  img:'https://images.unsplash.com/photo-1528127269322-539801943592?w=400&q=75' },
//   { id:'s2', title:'Neon Nights in Tokyo',     desc:"Shinjuku at midnight hits different when you're truly lost in it.",             lat:35.69, lng:139.69, author:'0x7d9A...32Ef', mood:'🔥', cat:'travel',    tags:['japan','neon','city'],    likes:88,  comments:14, time:Date.now()-18000000,  img:'https://images.unsplash.com/photo-1540959733332-eab4deabeeaf?w=400&q=75' },
//   { id:'s3', title:'Colosseum at Golden Hour', desc:'Waited 3 hours for this light. Worth every second.',                           lat:41.89, lng:12.49,  author:'0xC1a0...99bD', mood:'😌', cat:'photo',     tags:['rome','architecture'],   likes:129, comments:23, time:Date.now()-43200000,  img:'https://images.unsplash.com/photo-1552832230-c0197dd311b5?w=400&q=75' },
//   { id:'s4', title:'Street Food in Hoi An',    desc:'Cao lau from a 200-year-old family recipe. Best meal of my life.',             lat:15.88, lng:108.33, author:'0xB02c...4F7e', mood:'😊', cat:'food',      tags:['food','vietnam','street'],likes:67,  comments:11, time:Date.now()-7200000,   img:'https://images.unsplash.com/photo-1565299507177-b0ac66763828?w=400&q=75' },
//   { id:'s5', title:'Sahara Stars',             desc:'No light pollution. The Milky Way was touching the dunes.',                    lat:23.5,  lng:5.5,   author:'0x44fB...12Ac', mood:'🤩', cat:'adventure', tags:['desert','stars','africa'],likes:211, comments:31, time:Date.now()-172800000, img:'https://images.unsplash.com/photo-1509316785289-025f5b846b35?w=400&q=75' },
//   { id:'s6', title:'Kyoto Temple Rain',        desc:'Fushimi Inari in the rain is a completely different experience.',               lat:34.97, lng:135.77, author:'0x7d9A...32Ef', mood:'😌', cat:'photo',     tags:['japan','zen','rain'],    likes:93,  comments:18, time:Date.now()-28800000,  img:'https://images.unsplash.com/photo-1478436127897-769e1b3f0f36?w=400&q=75' },
//   { id:'s7', title:'Patagonian Storm',         desc:'Wind so strong I could barely stand. Mountains on fire with alpenglow.',       lat:-50.6, lng:-73.1, author:'0xC1a0...99bD', mood:'🔥', cat:'adventure', tags:['patagonia','mountains'],  likes:156, comments:28, time:Date.now()-259200000, img:'https://images.unsplash.com/photo-1584555613497-9ecf9dd06f68?w=400&q=75' },
//   { id:'s8', title:'Bali Ricefield Sunrise',   desc:'Tegallalang terraces in the first light. Pure meditation.',                    lat:-8.43, lng:115.28, author:'0xAb3F...71c2', mood:'😌', cat:'nature',    tags:['bali','rice','sunrise'],  likes:74,  comments:9,  time:Date.now()-10800000,  img:'https://images.unsplash.com/photo-1537996194471-e657df975ab4?w=400&q=75' },
//   { id:'s9', title:'NYC Skyline at Dusk',      desc:'From the Top of the Rock — the city turns gold and purple.',                   lat:40.76, lng:-73.98, author:'0x9Fa1...03Cc', mood:'🤩', cat:'photo',     tags:['nyc','skyline','sunset'], likes:184, comments:22, time:Date.now()-3600000,   img:'https://images.unsplash.com/photo-1490644658840-3f2e3f8c5625?w=400&q=75' },
//   { id:'s10',title:'Santorini Blue Domes',     desc:'Oia at 6am before the tourists arrive — silence and indigo.',                  lat:36.46, lng:25.37,  author:'0xD3b2...77Aa', mood:'😌', cat:'travel',    tags:['greece','santorini'],    likes:233, comments:41, time:Date.now()-50400000,  img:'https://images.unsplash.com/photo-1570077188670-e3a8d69ac5ff?w=400&q=75' },
// ];

/* ════════════════════════════════════════
   INIT
════════════════════════════════════════ */
async function init() {
  await delay(1900);
  const loader = document.getElementById('loading');
  loader.style.opacity = '0';
  setTimeout(() => loader.remove(), 500);

  S.stories = [];
  renderMarkers();
  renderFeed();
  syncCount();
  addVietnamIslandMarkers(); // Quần đảo Hoàng Sa & Trường Sa
  // Auto-reconnect Petra được xử lý bởi main.ts (tryAutoReconnect sau 2.2s)
  // Tải likes + comments từ server sau 3.5s (sau khi stories từ Shelby đã load xong)
  setTimeout(loadLikesForStories, 3500);

  // ── Deep link: ?story=ID ──
  // Đọc query param ngay khi load, đợi stories sẵn rồi fly + popup
  _handleDeepLink();
}

function _handleDeepLink() {
  const params  = new URLSearchParams(location.search);
  const storyId = params.get('story');
  if (!storyId) return;

  // Xóa query string khỏi URL (giữ sạch address bar) mà không reload trang
  const cleanUrl = location.origin + location.pathname;
  history.replaceState(null, '', cleanUrl);

  // Đợi stories load xong (tối đa 12s, poll mỗi 300ms)
  let waited = 0;
  const tryOpen = () => {
    const s = S.stories.find(x => x.id === storyId);
    if (s) {
      // Story đã có → fly + popup
      map.setView([s.lat, s.lng], 13, { animate: false });
      setTimeout(() => showPopup(s), 400);
      return;
    }
    waited += 300;
    if (waited < 12000) setTimeout(tryOpen, 300);
    else toast('⚠ Story not found — it may have been removed');
  };
  setTimeout(tryOpen, 300);
}

/* ════════════════════════════════════════
   MARKERS
════════════════════════════════════════ */
function renderMarkers() {
  S.markers.forEach(m => map.removeLayer(m));
  S.markers = [];
  filtered().forEach(addMarker);
  // Nếu heatmap đang bật → cập nhật lại với data mới
  if (typeof refreshHeatIfOn === 'function') refreshHeatIfOn();
}
window.renderMarkers = renderMarkers;

function filtered() {
  if (S.filter === 'all')  return S.stories;
  if (S.filter === 'mine') return S.stories.filter(s => s.isOwn);
  if (S.filter === 'chain') return S.stories.filter(s => s.fromChain);
  return S.stories.filter(s => s.cat === S.filter);
}

function addMarker(story) {
  const col  = MOOD_COLOR[story.mood] || '#4dffb4';
  const badge = story.fromChain
    ? `<div class="mk" style="background:${col};filter:drop-shadow(0 2px 6px ${col}55);outline:2px solid #4dffb4">${CAT_EMOJI[story.cat] || '📍'}</div>`
    : `<div class="mk" style="background:${col};filter:drop-shadow(0 2px 6px ${col}55)">${CAT_EMOJI[story.cat] || '📍'}</div>`;
  const icon = L.divIcon({ className: '', html: badge, iconSize: [34, 34], iconAnchor: [17, 34] });
  const m = L.marker([story.lat, story.lng], { icon })
    .addTo(map)
    .on('click', () => showPopup(story));
  S.markers.push(m);
    m._storyId = story.id;
}

function showPopup(story) {
  const imgHtml = story.img
    ? `<img class="pop-img" src="${esc(story.img)}" alt="${esc(story.title)}" onerror="this.style.display='none'">`
    : `<div class="pop-img-placeholder">${CAT_EMOJI[story.cat] || '📍'}</div>`;
  const tags  = (story.tags || []).map(t => `<span class="pop-tag">${esc(t)}</span>`).join('');
  const liked = S.walletAddr && story.likedBy.has(S.walletAddr);
  const chainBadge = story.fromChain
    ? `<div class="pop-chain-badge">⛓ ON-CHAIN · SHELBY TESTNET</div>` : '';
  const cmtCount = Array.isArray(story.commentList) ? story.commentList.length : (story.comments || 0);

  L.popup({ maxWidth: 300, className: '' })
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
          <button class="pop-btn pop-btn-like${liked ? ' liked' : ''}" id="poplike-${esc(story.id)}" onclick="likeStory('${esc(story.id)}')">❤ ${story.likes}</button>
          <button class="pop-btn pop-btn-cmt" data-id="${esc(story.id)}" onclick="openCommentModal('${esc(story.id)}')">💬 <span class="pop-cmt-num">${cmtCount}</span></button>
          <button class="pop-btn pop-btn-share" onclick="shareStory('${esc(story.id)}')">↗</button>
        </div>
      </div>`)
    .openOn(map);
}

/* ════════════════════════════════════════
   FEED
════════════════════════════════════════ */
function renderFeed() {
  const el = document.getElementById('storyList');
  el.innerHTML = [...filtered()].sort((a, b) => b.time - a.time).map(cardHTML).join('');
}
window.renderFeed = renderFeed;

function cardHTML(s) {
  const liked    = S.walletAddr && s.likedBy.has(S.walletAddr);
  const imgPart  = s.img
    ? `<img class="scard-img" src="${esc(s.img)}" alt="${esc(s.title)}" loading="lazy" onerror="this.style.display='none'">`
    : `<div class="scard-img-placeholder">${CAT_EMOJI[s.cat] || '📍'}</div>`;
  const desc      = esc(s.desc).slice(0, 100) + (s.desc.length > 100 ? '...' : '');
  const chainPill = s.fromChain
    ? `<span class="chain-pill">⛓ ON-CHAIN</span>` : '';
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
        <span class="scard-tag">${CAT_EMOJI[s.cat] || ''} ${esc(s.cat)}</span>
        <span class="scard-time">${timeAgo(s.time)}</span>
      </div>
      ${desc ? `<div class="scard-desc">${desc}</div>` : ''}
      <div class="scard-reactions">
        <button class="rxn-btn rxn-like${liked ? ' liked' : ''}" id="card-like-${esc(s.id)}" onclick="event.stopPropagation();likeStory('${esc(s.id)}')">
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

function flyTo(lat, lng, id) {
  if (window._globeWrap && window._globeWrap.classList.contains('active')) exitGlobe();
  map.flyTo([lat, lng], 12, { duration: 1.5 });
  map.once('moveend', () => {
    const s = S.stories.find(x => x.id === id);
    if (s) showPopup(s);
  });
}

/* ════════════════════════════════════════
   WALLET
   index.js defines connectWallet/disconnect first as fallback.
   main.ts will override window.connectWallet and window.disconnect
   after Shelby SDK has loaded.
════════════════════════════════════════ */
// _pendingWalletConnect: lưu type nếu user click trước khi main.ts load xong
window._pendingWalletConnect = null;

async function connectWallet(type) {
  closeModal('walletModal');

  // Nếu main.ts đã override và có hàm _connectWalletReal → gọi thẳng
  if (typeof window._connectWalletReal === 'function') {
    return window._connectWalletReal(type);
  }

  // main.ts chưa load xong → xử lý inline để không bị treo

  if (type === 'demo') {
    toast('🔑 Demo mode...');
    await delay(400);
    const addr  = '0xDEMO_' + Math.random().toString(16).slice(2, 8).toUpperCase();
    S.walletAddr = addr;
    S.walletType = 'demo';
    const short = addr.slice(0, 8) + '...' + addr.slice(-4);
    const btn   = document.getElementById('walletBtn');
    btn.textContent = short;
    btn.className   = 'connected';
    btn.onclick     = toggleProfile;
    document.getElementById('profAddr').textContent = addr;
    toast(`✅ Demo: ${short} — read only, not on-chain`);
    return;
  }

  if (type === 'petra') {
    // Petra không còn window.aptos — không check được trước khi main.ts load
    // Cứ lưu pending và để main.ts (AIP-62) xử lý
    window._pendingWalletConnect = 'petra';
    toast('🔍 Looking for Petra Wallet...');
    // Chờ tối đa 4s để main.ts load và xử lý
    for (let i = 0; i < 40; i++) {
      await delay(100);
      if (typeof window._connectWalletReal === 'function' && window._pendingWalletConnect === null) {
        return; // main.ts already handled it
      }
      if (typeof window._connectWalletReal === 'function' && window._pendingWalletConnect === 'petra') {
        window._pendingWalletConnect = null;
        return window._connectWalletReal('petra');
      }
    }
    // Timeout — main.ts không load được
    window._pendingWalletConnect = null;
    toast('❌ Could not load Shelby SDK. Please reload the page.');
    return;
  }

  if (type === 'metamask') {
    if (!window.ethereum) {
      toast('❌ MetaMask not installed');
      setTimeout(() => window.open('https://metamask.io', '_blank'), 800);
      return;
    }
    window._pendingWalletConnect = 'metamask';
    toast('🔗 Connecting MetaMask...');
    for (let i = 0; i < 40; i++) {
      await delay(100);
      if (typeof window._connectWalletReal === 'function' && window._pendingWalletConnect === null) return;
      if (typeof window._connectWalletReal === 'function' && window._pendingWalletConnect === 'metamask') {
        window._pendingWalletConnect = null;
        return window._connectWalletReal('metamask');
      }
    }
    window._pendingWalletConnect = null;
    toast('❌ Could not connect MetaMask. Please reload the page.');
    return;
  }

  toast(`❌ Unsupported wallet type: ${type}`);
}
window.connectWallet = connectWallet;

function disconnect() {
  if (S.walletType === 'petra' && window.aptos) {
    window.aptos.disconnect?.().catch(() => {});
  }
  S.walletAddr = null;
  S.walletType = null;
  const btn = document.getElementById('walletBtn');
  btn.textContent = 'CONNECT WALLET';
  btn.className   = '';
  btn.onclick     = () => openModal('walletModal');
  document.getElementById('profileCard').style.display = 'none';
  toast('🔌 Disconnected');
}
window.disconnect = disconnect;

function toggleProfile() {
  const el   = document.getElementById('profileCard');
  const open = el.style.display === 'block';
  el.style.display = open ? 'none' : 'block';
  if (!open) {
    const mine = S.stories.filter(s => s.isOwn);
    document.getElementById('profStories').textContent = mine.length;
    document.getElementById('profLikes').textContent   = mine.reduce((a, s) => a + s.likes, 0);
  }
}
window.toggleProfile = toggleProfile;

/* ════════════════════════════════════════
   POST FLOW
════════════════════════════════════════ */
function startPost() {
  if (!S.walletAddr) { openModal('walletModal'); return; }
  if (S.walletType === 'demo') {
    toast('⚠ Demo mode: connect Petra to post on-chain');
    return;
  }
  if (!S.lat) { toast('📍 Click the map to pick a location'); startPick(); }
  else openModal('postModal');
}
window.startPost = startPost;

function startPick() {
  closeModal('postModal');
  S.picking = true;
  document.getElementById('pickBar').classList.add('show');
  map.getContainer().style.cursor = 'crosshair';
}
window.startPick = startPick;

function hidePick() {
  S.picking = false;
  document.getElementById('pickBar').classList.remove('show');
  map.getContainer().style.cursor = '';
}

function cancelPick() { hidePick(); openModal('postModal'); }
window.cancelPick = cancelPick;

function handleImg(e) {
  const file = e.target.files[0]; if (!file) return;
  if (file.size > 5 * 1024 * 1024) { toast('⚠ Image max 5MB'); return; }
  const reader = new FileReader();
  reader.onload = ev => {
    S.imgData = ev.target.result;
    const p = document.getElementById('imgPreview');
    p.src = ev.target.result; p.style.display = 'block';
  };
  reader.readAsDataURL(file);
}
window.handleImg = handleImg;

function pickMood(btn) {
  S.mood = btn.dataset.mood;
  document.querySelectorAll('.mood-opt').forEach(b => b.classList.remove('sel'));
  btn.classList.add('sel');
}
window.pickMood = pickMood;

function pickCat(chip) {
  S.cat = chip.dataset.cat;
  document.querySelectorAll('.cat-chip').forEach(c => c.classList.remove('sel'));
  chip.classList.add('sel');
}
window.pickCat = pickCat;

async function submitStory() {
  const title = document.getElementById('iTitle').value.trim();
  const desc  = document.getElementById('iDesc').value.trim();

  if (!title)  { toast('⚠ Please enter a title'); return; }
  if (!S.lat)  { toast('⚠ Pick a location on the map'); return; }
  if (!S.walletAddr) { openModal('walletModal'); return; }

  const btn  = document.getElementById('subBtn');
  const prog = document.getElementById('progWrap');
  btn.disabled = true;
  btn.textContent = '⏳ Uploading to Shelby...';
  prog.classList.add('show');

  try {
    // Chờ main.ts signal ready (tối đa 5 giây)
    if (!window.shelby) {
      btn.textContent = '⏳ Connecting to Shelby...';
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('main.ts not loaded yet, please reload the page')), 5000);
        window.addEventListener('shelby:ready', () => { clearTimeout(t); resolve(); }, { once: true });
      });
    }
    btn.textContent = '⏳ Uploading to Shelby...';
    const shelbyAPI = window.shelby;
    const result = await shelbyAPI.upload({
      title, desc, image: S.imgData,
      lat: S.lat, lng: S.lng, mood: S.mood, cat: S.cat,
      wallet: S.walletAddr,
    });

    const story = {
      id: 's' + Date.now(),
      title, desc,
      lat: S.lat, lng: S.lng,
      author:   S.walletAddr.slice(0, 8) + '...' + S.walletAddr.slice(-4),
      fullAddr: S.walletAddr,
      mood: S.mood, cat: S.cat, tags: [S.cat],
      likes: 0, comments: 0, time: Date.now(),
      img: result.imageUrl || S.imgData,
      cid: result.cid,
      isOwn: true,
      fromChain: !S.walletAddr.startsWith('0xDEMO'),
      likedBy: new Set(),
    };

    S.stories.unshift(story);
    addMarker(story);
    renderFeed(); syncCount();

    // Reset form
    S.lat = S.lng = S.imgData = null; S.mood = '😊'; S.cat = 'photo';
    document.getElementById('iTitle').value = '';
    document.getElementById('iDesc').value = '';
    document.getElementById('imgPreview').style.display = 'none';
    document.getElementById('imgFile').value = '';
    document.getElementById('coordsTxt').textContent = 'Not selected';
    document.querySelectorAll('.mood-opt').forEach(b => b.classList.toggle('sel', b.dataset.mood === '😊'));
    document.querySelectorAll('.cat-chip').forEach(c => c.classList.toggle('sel', c.dataset.cat === 'photo'));
    if (S.tempMarker) { map.removeLayer(S.tempMarker); S.tempMarker = null; }

    prog.classList.remove('show');
    btn.disabled = false; btn.textContent = '✦ PUBLISH TO SHELBY';
    closeModal('postModal');

    const cidShort = result.cid.slice(0, 28) + '...';
    toast(`✅ Story published on-chain!\n${cidShort}`);
    map.flyTo([story.lat, story.lng], 14, { duration: 2 });

  } catch (err) {
    console.error('[GeoStory] submitStory error:', err);
    prog.classList.remove('show');
    btn.disabled = false; btn.textContent = '✦ PUBLISH TO SHELBY';
    toast(`❌ Upload failed: ${err?.message ?? err}`);
  }
}
window.submitStory = submitStory;

/* ════════════════════════════════════════
   LOAD STORIES FROM SHELBY (manual)
════════════════════════════════════════ */
async function refreshFromShelby() {
  if (!S.walletAddr || S.walletAddr.startsWith('0xDEMO')) {
    toast('⚠ Connect Petra to load stories from chain');
    return;
  }
  if (S.shelbyLoading) return;
  S.shelbyLoading = true;
  toast('🔄 Loading from Shelby...');
  try {
    await window.loadUserStoriesFromShelby?.(S.walletAddr);
  } catch (e) {
    toast('❌ ' + (e?.message ?? e));
  } finally {
    S.shelbyLoading = false;
  }
}
window.refreshFromShelby = refreshFromShelby;

/* ════════════════════════════════════════
   REACTIONS — persist to Shelby
════════════════════════════════════════ */

// Tải likes cho tất cả stories từ server (gọi sau khi stories đã load)
async function loadLikesForStories() {
  if (!S.stories.length) return;
  try {
    const targets = S.stories.filter(s => s.fromChain).slice(0, 20);
    if (!targets.length) return;

    // Chạy tối đa 5 request song song để không spam server
    const CHUNK = 5;
    for (let i = 0; i < targets.length; i += CHUNK) {
      const batch = targets.slice(i, i + CHUNK);
      await Promise.allSettled(
        batch.map(async s => {
          try {
            // Timeout 4s mỗi request — không để treo cả trang
            const ctrl  = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 4000);
            const r     = await fetch(`/api/stories/${s.id}/likes`, { signal: ctrl.signal });
            clearTimeout(timer);

            if (!r.ok) return; // 404 or error → keep likes = 0
            const data  = await r.json();
            s.likes     = typeof data.count === 'number' ? data.count : 0;
            s.likedBy   = new Set(Array.isArray(data.likedBy) ? data.likedBy : []);
          } catch { /* timeout or network error → skip, don't block */ }
        })
      );
    }

    renderFeed();
    // Cập nhật popup đang mở nếu có
    S.stories.forEach(s => _updateLikeButtons(s));
    // Load comments in background
    setTimeout(loadCommentsForStories, 800);
  } catch (e) {
    console.warn('[GeoStory] loadLikesForStories:', e);
  }
}
window.loadLikesForStories = loadLikesForStories;

async function likeStory(id) {
  if (!S.walletAddr) { toast('Connect wallet to like'); return; }
  const s = S.stories.find(x => x.id === id); if (!s) return;

  // Optimistic update ngay lập tức
  const alreadyLiked = s.likedBy.has(S.walletAddr);
  if (alreadyLiked) { s.likedBy.delete(S.walletAddr); s.likes = Math.max(0, s.likes - 1); }
  else              { s.likedBy.add(S.walletAddr);    s.likes++; }

  // Cập nhật UI ngay (không chờ server)
  _updateLikeButtons(s);
  renderFeed();

  // Story local (demo / chưa lên chain) → chỉ lưu in-memory
  if (!s.fromChain || S.walletAddr.startsWith('0xDEMO')) {
    toast(alreadyLiked ? '💔 Unliked' : '❤ Liked!');
    return;
  }

  // Persist lên server
  try {
    const r = await fetch(`/api/stories/${id}/like`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ wallet: S.walletAddr }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error ?? 'Like failed');

    // Đồng bộ lại từ server
    s.likes   = data.count ?? s.likes;
    s.likedBy = new Set(Array.isArray(data.likedBy) ? data.likedBy : [...s.likedBy]);
    _updateLikeButtons(s);
    renderFeed();

    toast(data.action === 'liked' ? '❤ Liked!' : '💔 Unliked');
  } catch (err) {
    // Rollback optimistic update nếu server lỗi
    if (alreadyLiked) { s.likedBy.add(S.walletAddr); s.likes++; }
    else              { s.likedBy.delete(S.walletAddr); s.likes = Math.max(0, s.likes - 1); }
    renderFeed();
    toast('⚠ Could not save like: ' + (err?.message ?? err));
    console.error('[GeoStory] likeStory error:', err);
  }
}
window.likeStory = likeStory;

function _updateLikeButtons(s) {
  const liked = S.walletAddr && s.likedBy.has(S.walletAddr);
  // Card button
  const cardBtn = document.getElementById(`card-like-${s.id}`);
  if (cardBtn) {
    cardBtn.querySelector('.rxn-num').textContent = s.likes;
    cardBtn.classList.toggle('liked', !!liked);
  }
  // Popup button
  const popBtn = document.getElementById(`poplike-${s.id}`);
  if (popBtn) {
    popBtn.textContent = `❤ ${s.likes}`;
    popBtn.classList.toggle('liked', !!liked);
  }
}

/* ════════════════════════════════════════
   COMMENT SYSTEM
════════════════════════════════════════ */
// Load comments cho 1 story
async function loadComments(storyId) {
  const s = S.stories.find(x => x.id === storyId);
  if (!s) return [];
  if (Array.isArray(s.commentList) && s._cmtLoaded) return s.commentList;
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r     = await fetch(`/api/stories/${storyId}/comments`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return [];
    const data = await r.json();
    s.commentList = Array.isArray(data.comments) ? data.comments : [];
    s.comments    = s.commentList.length;
    s._cmtLoaded  = true;
    return s.commentList;
  } catch { return []; }
}

// Mở modal comment
async function openCommentModal(storyId) {
  const s = S.stories.find(x => x.id === storyId);
  if (!s) return;

  // Tạo modal nếu chưa có
  let modal = document.getElementById('commentModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id        = 'commentModal';
    modal.className = 'overlay';
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
    modal.addEventListener('click', e => { if (e.target === modal) closeModal('commentModal'); });
    document.body.appendChild(modal);
  }

  // Set active story
  modal._storyId = storyId;
  document.getElementById('cmtModalTitle').textContent = `${s.mood} ${s.title}`;
  document.getElementById('cmtModalSub').textContent = `// ${s.fromChain ? 'SHELBY · ON-CHAIN' : 'LOCAL'}`;
  document.getElementById('cmtInput').value = '';
  openModal('commentModal');
  renderComments(storyId, []);

  // Load comments async
  const comments = await loadComments(storyId);
  renderComments(storyId, comments);
}
window.openCommentModal = openCommentModal;

function renderComments(storyId, comments) {
  const el = document.getElementById('cmtList');
  if (!el) return;
  if (!comments.length) {
    el.innerHTML = '<div class="cmt-empty">No comments yet — be the first! 💬</div>';
    return;
  }
  el.innerHTML = comments.map(c => `
    <div class="cmt-item">
      <div class="cmt-meta">
        <span class="cmt-wallet">${esc(c.wallet ? c.wallet.slice(0,8) + '...' + c.wallet.slice(-4) : 'anon')}</span>
        <span class="cmt-time">${timeAgo(c.time)}</span>
      </div>
      <div class="cmt-text">${esc(c.text)}</div>
    </div>`).join('');
  el.scrollTop = el.scrollHeight;
}

async function submitComment() {
  const modal = document.getElementById('commentModal');
  if (!modal) return;
  const storyId = modal._storyId;
  if (!storyId) return;

  if (!S.walletAddr) { toast('Connect wallet to comment'); return; }
  if (S.walletAddr.startsWith('0xDEMO')) { toast('⚠ Demo mode — comments not saved on-chain'); return; }

  const input = document.getElementById('cmtInput');
  const text  = input.value.trim();
  if (!text) { toast('⚠ Write something first'); return; }

  const btn = document.getElementById('cmtSendBtn');
  btn.disabled    = true;
  btn.textContent = '...posting';

  try {
    const r = await fetch(`/api/stories/${storyId}/comments`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ wallet: S.walletAddr, text }),
    });
    const data = await r.json();
    if (!r.ok || !data.success) throw new Error(data.error ?? 'Failed');

    // Update local state
    const s = S.stories.find(x => x.id === storyId);
    if (s) {
      if (!Array.isArray(s.commentList)) s.commentList = [];
      s.commentList.push(data.comment);
      s.comments = s.commentList.length;
    }
    input.value = '';
    renderComments(storyId, s?.commentList || []);

    // Cập nhật số comment trực tiếp trên card trong feed (không re-render toàn bộ)
    const newCount = s?.comments ?? data.count ?? 0;
    const cardCmtNum = document.querySelector(`.rxn-cmt[data-id="${storyId}"] .rxn-num`);
    if (cardCmtNum) cardCmtNum.textContent = newCount;

    // Cập nhật số comment trên popup map nếu đang mở
    const popCmtBtn = document.querySelector(`.pop-btn-cmt[data-id="${storyId}"] .pop-cmt-num`);
    if (popCmtBtn) popCmtBtn.textContent = newCount;

    toast('💬 Comment posted on-chain!');
  } catch (err) {
    toast('⚠ Could not post: ' + (err?.message ?? err));
  } finally {
    btn.disabled    = false;
    btn.textContent = '↑ POST';
  }
}
window.submitComment = submitComment;

// Load comments cho tất cả stories (batch, sau khi stories load xong)
async function loadCommentsForStories() {
  const targets = S.stories.filter(s => s.fromChain).slice(0, 20);
  if (!targets.length) return;
  const CHUNK = 5;
  for (let i = 0; i < targets.length; i += CHUNK) {
    await Promise.allSettled(targets.slice(i, i + CHUNK).map(s => loadComments(s.id)));
  }
  renderFeed();
}
window.loadCommentsForStories = loadCommentsForStories;

function shareStory(id) {
  const base = location.origin + location.pathname;
  const url  = base + '?story=' + encodeURIComponent(id);
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url)
      .then(() => toast('🔗 Link copied!'))
      .catch(() => toast('Link: ' + url));
  } else {
    toast('Link: ' + url);
  }
}
window.shareStory = shareStory;

/* ════════════════════════════════════════
   FILTERS
════════════════════════════════════════ */
function setFilter(f, btn) {
  S.filter = f;
  document.querySelectorAll('.f-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderMarkers(); renderFeed();
}
window.setFilter = setFilter;

/* ════════════════════════════════════════
   MAP TOOLS
════════════════════════════════════════ */
/* ════════════════════════════════════════
   HEATMAP
════════════════════════════════════════ */
let _heatLayer = null;

function buildHeatLayer() {
  const stories = S.stories.filter(s => s.lat && s.lng);
  if (!stories.length) return null;

  // Mỗi story = 1 điểm với intensity cố định — mật độ địa lý tự nhiên
  const points = stories.map(s => [s.lat, s.lng, 1.0]);

  return L.heatLayer(points, {
    radius:  35,
    blur:    25,
    maxZoom: 12,
    max:     1.0,
    gradient: { 0.2: '#0d2b4e', 0.4: '#0a4a6e', 0.6: '#4dffb4', 0.8: '#ffd760', 1.0: '#ff6b35' },
  });
}

function toggleHeat(btn) {
  const isOn = btn.classList.toggle('on');

  if (isOn) {
    _heatLayer = buildHeatLayer();
    if (_heatLayer) {
      _heatLayer.addTo(map);
      // Ẩn marker thường để heatmap rõ hơn
      S.markers.forEach(m => m.setOpacity(0.15));
      toast('🌡 Heatmap ON');
    } else {
      btn.classList.remove('on');
      toast('⚠ Chưa có story nào để hiển thị heatmap');
    }
  } else {
    if (_heatLayer) { map.removeLayer(_heatLayer); _heatLayer = null; }
    // Hiện lại marker
    S.markers.forEach(m => m.setOpacity(1));
    toast('🌡 Heatmap OFF');
  }
}
window.toggleHeat = toggleHeat;

// Cập nhật heatmap live khi stories thay đổi (nếu đang bật)
function refreshHeatIfOn() {
  const btn = document.getElementById('heatBtn');
  if (!btn?.classList.contains('on')) return;
  if (_heatLayer) map.removeLayer(_heatLayer);
  _heatLayer = buildHeatLayer();
  if (_heatLayer) _heatLayer.addTo(map);
}

function locateMe() {
  map.locate({ setView: true, maxZoom: 14 });
  map.once('locationfound', e => {
    L.circle(e.latlng, { radius: e.accuracy, color: '#4dffb4', fillOpacity: .08, weight: 1 }).addTo(map);
    toast('📍 Location found!');
  });
  map.once('locationerror', () => toast('⚠ Could not find location'));
}
window.locateMe = locateMe;

/* ════════════════════════════════════════
   UI HELPERS
════════════════════════════════════════ */
function toggleFeed() {
  const sidebar = document.getElementById('sidebar');
  const geoSearchWrap = document.getElementById('geoSearchWrap');

  sidebar.classList.toggle('open');

  if (window.innerWidth <= 768) {
    geoSearchWrap.classList.toggle(
      'hide-mobile',
      sidebar.classList.contains('open')
    );
  }
}
window.toggleFeed = toggleFeed;

function openModal(id)  { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }
window.openModal  = openModal;
window.closeModal = closeModal;

function overlayClick(e, id) { if (e.target.id === id) closeModal(id); }
window.overlayClick = overlayClick;

let _toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}
window.toast = toast;

function syncCount() { document.getElementById('storyCount').textContent = S.stories.length; }
window.syncCount = syncCount;

/* ════════════════════════════════════════
   IMAGE DRAG & DROP
════════════════════════════════════════ */
const imgDrop = document.getElementById('imgDrop');
imgDrop.addEventListener('dragover', e => { e.preventDefault(); imgDrop.classList.add('drag'); });
imgDrop.addEventListener('dragleave', () => imgDrop.classList.remove('drag'));
imgDrop.addEventListener('drop', e => {
  e.preventDefault(); imgDrop.classList.remove('drag');
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) {
    if (file.size > 5 * 1024 * 1024) { toast('⚠ Image max 5MB'); return; }
    const r = new FileReader();
    r.onload = ev => {
      S.imgData = ev.target.result;
      const p = document.getElementById('imgPreview');
      p.src = ev.target.result; p.style.display = 'block';
    };
    r.readAsDataURL(file);
  }
});

/* ════════════════════════════════════════
   KEYBOARD SHORTCUTS
════════════════════════════════════════ */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.overlay.show').forEach(el => closeModal(el.id));
    if (S.picking) cancelPick();
  }
  if (e.key === 'f' && !e.target.matches('input,textarea')) toggleFeed();
  if (e.key === 'n' && !e.target.matches('input,textarea')) startPost();
  if (e.key === 'r' && !e.target.matches('input,textarea')) refreshFromShelby();
});

/* ════════════════════════════════════════
   START
════════════════════════════════════════ */
init();


// /* ════════════════════════════════════════
//    GEO-NOTIFY — Hệ thống thông báo nâng cao
//    Thay thế / bổ sung cho toast() cũ
// ════════════════════════════════════════ */
// (function initNotifySystem() {
//   // Tạo container stack
//   if (!document.getElementById('notifyStack')) {
//     const stack = document.createElement('div');
//     stack.id = 'notifyStack';
//     document.body.appendChild(stack);
//   }

//   const ICONS = {
//     success: '✦',
//     error:   '✕',
//     warn:    '⚠',
//     info:    '◎',
//     chain:   '⛓',
//   };
//   const TITLES = {
//     success: 'SUCCESS',
//     error:   'ERROR',
//     warn:    'WARNING',
//     info:    'INFO',
//     chain:   'ON-CHAIN',
//   };

//   /**
//    * notify(msg, type, opts)
//    * type: 'success' | 'error' | 'warn' | 'info' | 'chain'
//    * opts: { title, duration, id }
//    */
//   window.notify = function notify(msg, type = 'info', opts = {}) {
//     const stack = document.getElementById('notifyStack');
//     const dur   = opts.duration ?? (type === 'error' ? 5000 : 4000);
//     const title = opts.title  ?? TITLES[type] ?? 'NOTIFY';
//     const icon  = ICONS[type] ?? '●';

//     const el = document.createElement('div');
//     el.className = `nfy nfy-${type}`;
//     el.style.setProperty('--dur', dur + 'ms');
//     el.innerHTML = `
//       <div class="nfy-icon">${icon}</div>
//       <div class="nfy-body">
//         <div class="nfy-title">${title}</div>
//         <div class="nfy-msg">${msg}</div>
//       </div>
//       <button class="nfy-close" aria-label="Dismiss">✕</button>
//       <div class="nfy-progress"></div>
//     `;

//     // Dismiss on click or X
//     const dismiss = () => {
//       el.classList.add('nfy-out');
//       el.addEventListener('transitionend', () => el.remove(), { once: true });
//     };
//     el.addEventListener('click', dismiss);

//     stack.appendChild(el);
//     // Trigger animation sau 1 frame
//     requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('nfy-in')));

//     const timer = setTimeout(dismiss, dur);
//     el.querySelector('.nfy-close').addEventListener('click', e => {
//       e.stopPropagation(); clearTimeout(timer); dismiss();
//     });

//     return { dismiss };
//   };

//   // Override toast() để dùng hệ thống mới, đoán loại từ nội dung
//   const _origToast = window.toast;
//   window.toast = function smartToast(msg) {
//     if (typeof msg !== 'string') { _origToast && _origToast(msg); return; }
//     let type = 'info';
//     if (/✦|published|posted|success|connected|found|copied|on-chain/i.test(msg)) type = 'success';
//     else if (/⚠|warning|could not|failed|error|denied|max/i.test(msg))           type = 'warn';
//     else if (/✕|disconnect/i.test(msg))                                            type = 'error';
//     else if (/chain|shelby|protocol|block|tx/i.test(msg))                         type = 'chain';
//     notify(msg, type);
//   };
// })();

/* ════════════════════════════════════════
   GEO-SEARCH — Tìm kiếm địa chỉ / toạ độ
════════════════════════════════════════ */
(function initGeoSearch() {
  // Chèn HTML vào body
  const wrap = document.createElement('div');
  wrap.id = 'geoSearchWrap';
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

  const input   = document.getElementById('geoSearchInput');
  const results = document.getElementById('geoResults');
  const clearBtn= document.getElementById('geoSearchClear');

  let _debTimer = null;
  let _selectedIdx = -1;
  let _items = [];
  let _flyMarker = null;

  // Phím tắt "/" để focus
  document.addEventListener('keydown', e => {
    if (e.key === '/' && !e.target.matches('input,textarea')) {
      e.preventDefault();
      input.focus(); input.select();
    }
    if (e.key === 'Escape' && document.activeElement === input) {
      closeResults(); input.blur();
    }
  });

  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearBtn.classList.toggle('vis', q.length > 0);
    _selectedIdx = -1;
    clearTimeout(_debTimer);
    if (!q) { closeResults(); return; }
    _debTimer = setTimeout(() => doSearch(q), 380);
  });

  input.addEventListener('keydown', e => {
    if (!results.classList.contains('open')) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSelect(1); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); moveSelect(-1); }
    if (e.key === 'Enter')     {
      e.preventDefault();
      if (_selectedIdx >= 0 && _items[_selectedIdx]) flyTo(_items[_selectedIdx]);
      else if (_items[0]) flyTo(_items[0]);
    }
  });

  clearBtn.addEventListener('click', () => {
    input.value = ''; clearBtn.classList.remove('vis');
    closeResults(); input.focus();
    if (_flyMarker) { map.removeLayer(_flyMarker); _flyMarker = null; }
  });

  // Click ngoài → đóng
  document.addEventListener('click', e => {
    if (!wrap.contains(e.target)) closeResults();
  });

  function closeResults() {
    results.classList.remove('open');
    results.innerHTML = '';
    _items = []; _selectedIdx = -1;
  }

  function moveSelect(dir) {
    const rows = results.querySelectorAll('.geo-result-item');
    rows.forEach(r => r.classList.remove('selected'));
    _selectedIdx = Math.max(0, Math.min(_items.length - 1, _selectedIdx + dir));
    rows[_selectedIdx]?.classList.add('selected');
    rows[_selectedIdx]?.scrollIntoView({ block: 'nearest' });
  }

  async function doSearch(q) {
    // Thử parse toạ độ trực tiếp: "lat, lng"
    const coordMatch = q.match(/^(-?\d+\.?\d*)\s*[,\s]\s*(-?\d+\.?\d*)$/);
    if (coordMatch) {
      const lat = parseFloat(coordMatch[1]), lng = parseFloat(coordMatch[2]);
      if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        renderItems([{
          display_name: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
          name: 'Custom Coordinates',
          lat: String(lat), lon: String(lng),
          _isCoord: true,
        }]);
        return;
      }
    }

    showLoading();
    try {
      const url = `/api/geocode/search?q=${encodeURIComponent(q)}&limit=6`;
      const res  = await fetch(url);
      const data = await res.json();
      if (!data.length) { showEmpty(q); return; }
      renderItems(data);
    } catch {
      showEmpty(q, true);
    }
  }

  function showLoading() {
    results.innerHTML = `<div class="geo-status"><div class="geo-spin"></div>SEARCHING...</div>`;
    results.classList.add('open');
  }
  function showEmpty(q, isErr) {
    results.innerHTML = `<div class="geo-status">${isErr ? '⚠ Network error' : `No results for "${q}"`}</div>`;
    results.classList.add('open');
  }

  function renderItems(data) {
    _items = data;
    results.innerHTML = data.map((item, i) => {
      const name    = item.name || item.display_name.split(',')[0];
      const detail  = item._isCoord ? 'Custom pin' : item.display_name;
      const lat     = parseFloat(item.lat).toFixed(3);
      const lng     = parseFloat(item.lon).toFixed(3);
      const typeIcon = getTypeIcon(item.type || item.class || '');
      // Highlight query trong tên
      const qRaw = input.value.trim();
      const hiName = name.replace(new RegExp(`(${qRaw.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})`, 'gi'), '<mark>$1</mark>');
      return `
        <div class="geo-result-item" data-idx="${i}">
          <div class="geo-result-pin">${typeIcon}</div>
          <div class="geo-result-body">
            <div class="geo-result-name">${hiName}</div>
            <div class="geo-result-detail">${detail}</div>
          </div>
          <div class="geo-result-coords">${lat}<br>${lng}</div>
        </div>`;
    }).join('');

    results.classList.add('open');

    results.querySelectorAll('.geo-result-item').forEach(row => {
      row.addEventListener('click', () => {
        const idx = parseInt(row.dataset.idx);
        flyTo(_items[idx]);
      });
      row.addEventListener('mouseenter', () => {
        results.querySelectorAll('.geo-result-item').forEach(r => r.classList.remove('selected'));
        row.classList.add('selected');
        _selectedIdx = parseInt(row.dataset.idx);
      });
    });
  }

  function flyTo(item) {
    const lat = parseFloat(item.lat);
    const lng = parseFloat(item.lon);
    const name = item.name || item.display_name.split(',')[0];

    // Xoá marker cũ
    if (_flyMarker) { map.removeLayer(_flyMarker); _flyMarker = null; }

    // Bay tới vị trí
    map.flyTo([lat, lng], 14, { duration: 1.4, easeLinearity: 0.3 });

    // Tạo marker đặc trưng
    const markerEl = document.createElement('div');
    markerEl.className = 'geo-fly-marker';
    markerEl.innerHTML = `
  <div style="
  display:inline-flex;
  align-items:center;
  justify-content:center;
  gap:6px;

  background:var(--accent);
  color:var(--bg);

  font-family:'IBM Plex Mono', monospace;
  font-size:0.6rem;
  font-weight:700;
  line-height:1;

  padding:6px 10px;
  border-radius:999px;

  white-space:nowrap;
  max-width:160px;
  overflow:hidden;

  box-shadow:0 4px 16px rgba(77,255,180,0.45);
">
  
  <span style="
    display:flex;
    align-items:center;
    justify-content:center;

    width:12px;
    height:12px;

    line-height:12px;
    font-size:10px;
    flex-shrink:0;
  ">📍</span>

  <span style="
    overflow:hidden;
    text-overflow:ellipsis;
  ">
    ${name.slice(0,22)}${name.length>22?'…':''}
  </span>

</div>
    `;
    _flyMarker = L.marker([lat, lng], {
      icon: L.divIcon({ html: markerEl.outerHTML, className: '', iconAnchor: [0, 32] }),
      zIndexOffset: 1000,
    }).addTo(map);

    // Cập nhật input & đóng dropdown
    input.value = name;
    clearBtn.classList.add('vis');
    closeResults();

    notify(`Flew to <b>${name}</b>`, 'success', { title: 'LOCATION FOUND', duration: 3000 });
  }

  function getTypeIcon(type) {
    const t = type.toLowerCase();
    if (/restaurant|food|cafe|bar/.test(t))     return '🍜';
    if (/hotel|hostel|motel/.test(t))            return '🏨';
    if (/airport|aerodrome/.test(t))             return '✈';
    if (/park|garden|nature|forest/.test(t))     return '🌿';
    if (/museum|art|gallery/.test(t))            return '🎨';
    if (/beach|coast|sea/.test(t))               return '🏖';
    if (/mountain|peak|hill/.test(t))            return '⛰';
    if (/city|town|village|place/.test(t))       return '🏙';
    if (/church|temple|mosque|shrine/.test(t))   return '⛩';
    if (/hospital|clinic/.test(t))               return '🏥';
    if (/school|university|college/.test(t))     return '🏫';
    return '📍';
  }
})();

// Lịch sử chat trong session
const companionHistory = [];

async function askCompanion(userMessage) {
  const center = map.getCenter();

  // Thu thập nearby stories (trong vòng 50km)
  const nearby = S.stories
    .filter(s => getDistance(s.lat, s.lng, center.lat, center.lng) < 50)
    .slice(0, 5)
    .map(s => ({ title: s.title, desc: s.desc, mood: s.mood, cat: s.cat, author: s.author }));

  const res = await fetch("/api/ai/companion", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: userMessage,
      history: companionHistory.slice(-6), // giữ 6 lượt gần nhất
      context: {
        placeName: window._currentPlaceName ?? "area being viewed",
        lat: center.lat,
        lng: center.lng,
        nearby,
        time: new Date().toLocaleString("vi-VN"),
      }
    })
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error);

  // Lưu lịch sử multi-turn
  companionHistory.push({ role: "user",  text: userMessage });
  companionHistory.push({ role: "model", text: data.reply });

  return data.reply;
}

// Helper tính khoảng cách (km) — Haversine đơn giản
function getDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

/* ════════════════════════════════════════
   AI TRAVEL COMPANION
════════════════════════════════════════ */

const _aiHistory = [];

function toggleAI() {
  const panel = document.getElementById('aiPanel');
  const btn   = document.getElementById('aiBtn');
  const open  = panel.classList.toggle('open');
  btn.classList.toggle('open', open);
  if (open) _aiUpdateLocation();
}

// Reverse geocode vị trí hiện tại trên bản đồ
// Gọi qua /api/geocode/reverse (server proxy) để tránh lỗi CORS Nominatim
function _aiUpdateLocation() {
  const c   = map.getCenter();
  const locEl = document.getElementById('aiLoc');

  fetch(`/api/geocode/reverse?lat=${c.lat}&lon=${c.lng}`)
    .then(r => {
      if (!r.ok) throw new Error('geocode ' + r.status);
      return r.json();
    })
    .then(d => {
      const name = d.address?.city
        || d.address?.town
        || d.address?.village
        || d.address?.county
        || d.address?.state
        || d.display_name?.split(',')[0]
        || null;
      window._aiPlaceName = name;
      if (locEl) locEl.textContent = '📍 ' + (name || '—');
    })
    .catch(() => {
      // Giữ nguyên giá trị cũ nếu lỗi, không crash UI
    });
}

// Tính khoảng cách km giữa 2 toạ độ (Haversine)
function getDistance(lat1, lng1, lat2, lng2) {
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180)
    * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Detect category từ câu hỏi người dùng
function _aiDetectCategory(text) {
  const t = text.toLowerCase();
  // food / ẩm thực
  if (/food|eat|ăn|ẩm thực|đặc sản|món|nhà hàng|quán|restaurant|cuisine|dish|meal|snack|coffee|cà phê/.test(t)) return 'food';
  // adventure / phiêu lưu
  if (/adventure|phiêu lưu|leo núi|hiking|trek|climb|waterfall|thác|rừng|jungle|outdoor|extreme/.test(t)) return 'adventure';
  // art / nghệ thuật
  if (/art|nghệ thuật|mural|painting|gallery|triển lãm|graffiti|sculpture/.test(t)) return 'art';
  // nature / thiên nhiên
  if (/nature|thiên nhiên|landscape|cảnh vật|forest|rừng|beach|biển|mountain|núi|sunset|sunrise|bình minh|hoàng hôn/.test(t)) return 'nature';
  // travel / du lịch
  if (/travel|du lịch|tour|trip|journey|chuyến đi|destination|điểm đến/.test(t)) return 'travel';
  // photo
  if (/photo|photograph|chụp ảnh|picture|shot|selfie|ảnh/.test(t)) return 'photo';
  return null;
}

// Gửi câu hỏi tới AI
async function aiSend() {
  const input = document.getElementById('aiInput');
  const text  = input.value.trim();
  if (!text) return;
  input.value = '';

  // Ẩn quick prompts sau lần hỏi đầu
  const quickEl = document.getElementById('aiQuick');
  if (quickEl) quickEl.style.display = 'none';

  _aiAddMsg(text, 'user');
  _aiAddTyping();

  try {
    const center = map.getCenter();

    // Radius thu hẹp theo zoom — tránh truyền story quá xa
    const zoom     = map.getZoom();
    const radiusKm = zoom >= 12 ? 10
                   : zoom >= 8  ? 50
                   : zoom >= 5  ? 200
                   : 500;

    // Detect category từ câu hỏi
    const detectedCat = _aiDetectCategory(text);

    // Lấy story gần nhất, ưu tiên category khớp
    const inRange = (S.stories || [])
      .filter(s => getDistance(s.lat, s.lng, center.lat, center.lng) < radiusKm)
      .sort((a, b) => {
        const dA = getDistance(a.lat, a.lng, center.lat, center.lng);
        const dB = getDistance(b.lat, b.lng, center.lat, center.lng);
        return dA - dB;
      });

    // Nếu có category khớp → lấy tối đa 5 story đúng category, fallback các story khác
    let nearby;
    if (detectedCat) {
      const catMatch  = inRange.filter(s => s.cat === detectedCat).slice(0, 5);
      const catOthers = inRange.filter(s => s.cat !== detectedCat).slice(0, Math.max(0, 5 - catMatch.length));
      nearby = [...catMatch, ...catOthers];
    } else {
      nearby = inRange.slice(0, 5);
    }

    // Map để gửi lên API — giữ đủ field để _aiAddMsg render chip
    const nearbyPayload = nearby.map(s => ({
      id:     s.id,
      title:  s.title,
      desc:   s.desc  || '',
      mood:   s.mood  || '😊',
      cat:    s.cat   || 'photo',
      author: s.author || 'unknown',
      lat:    s.lat,
      lng:    s.lng,
    }));

    const res = await fetch('/api/ai/companion', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        history: _aiHistory.slice(-6), // giữ 6 lượt gần nhất
        context: {
          placeName:   window._aiPlaceName || null,
          lat:         center.lat,
          lng:         center.lng,
          nearby:      nearbyPayload,
          detectedCat: detectedCat || null,
          time:        new Date().toLocaleString('vi-VN'),
        },
      }),
    });

    const data = await res.json();
    _aiRemoveTyping();

    if (!res.ok) {
      _aiAddMsg(data.error || 'An error occurred, please try again later!', 'ai');
      return;
    }

    const reply = data.reply || '';
    _aiHistory.push({ role: 'user',  text });
    _aiHistory.push({ role: 'model', text: reply });

    // Truyền nearby (với full story ref) vào _aiAddMsg để render story chips
    _aiAddMsg(reply, 'ai', nearby);

  } catch {
    _aiRemoveTyping();
    _aiAddMsg('Unable to connect to AI, please try again later!', 'ai');
  }
}

// Nút gợi ý nhanh
function aiQuickAsk(text) {
  document.getElementById('aiInput').value = text;
  aiSend();
}

// Render tin nhắn — nếu là AI thì tìm story được nhắc và hiện chip
function _aiAddMsg(text, role, nearbyStories) {
  const wrap = document.getElementById('aiMessages');
  const div  = document.createElement('div');
  div.className = 'ai-msg ai-msg--' + role;

  if (role === 'ai') {
    div.innerHTML = _aiEscapeHtml(text);

    // Tìm story được nhắc tên, hoặc fallback toàn bộ nearbyStories (tối đa 3)
    const mentioned = _aiExtractMentioned(text, nearbyStories || []);
    if (mentioned.length > 0) {
      const chipsWrap = document.createElement('div');
      chipsWrap.className = 'ai-story-chips';

      mentioned.forEach(s => {
        // Lookup story đầy đủ từ S.stories để có img, desc, likedBy...
        const full = (S.stories || []).find(x => x.id === s.id) || s;

        const chip = document.createElement('button');
        chip.className = 'ai-story-chip';
        chip.innerHTML = `
          <span class="ai-chip-cat">${(CAT_EMOJI && CAT_EMOJI[s.cat]) || '📍'}</span>
          <span class="ai-chip-title">${_aiEscapeHtml(s.title)}</span>
          <span class="ai-chip-badge">${_aiEscapeHtml(s.cat)}</span>
          <span class="ai-chip-arrow">→</span>
        `;

        chip.onclick = () => {
          // Đóng AI panel, bay đến vị trí, mở full popup
          if (window._globeWrap && window._globeWrap.classList.contains('active')) exitGlobe();
          map.flyTo([s.lat, s.lng], 14, { duration: 1.2 });
          map.once('moveend', () => showPopup(full));
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

// Tìm story được nhắc đến trong reply (tối đa 3).
// Nếu không có tên nào khớp → fallback hiển thị tất cả nearbyStories (tối đa 3)
function _aiExtractMentioned(replyText, nearbyStories) {
  if (!nearbyStories?.length) return [];
  const lower  = replyText.toLowerCase();
  const found  = [];

  for (const s of nearbyStories) {
    if (found.length >= 3) break;
    const title = (s.title || '').toLowerCase().trim();
    if (title.length >= 3 && lower.includes(title)) {
      found.push(s);
    }
  }

  // Nếu không match tên nào → hiện tất cả story trong danh sách (tối đa 3)
  if (found.length === 0) return nearbyStories.slice(0, 3);
  return found;
}

function _aiEscapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _aiAddTyping() {
  const wrap = document.getElementById('aiMessages');
  const div  = document.createElement('div');
  div.className = 'ai-msg ai-msg--ai';
  div.id        = 'aiTyping';
  div.innerHTML = '<div class="ai-typing"><span></span><span></span><span></span></div>';
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
}

function _aiRemoveTyping() {
  document.getElementById('aiTyping')?.remove();
}

// Cập nhật tên địa điểm khi map dừng
let _geocodeTimer = null;
map.on('moveend', () => {
  if (!document.getElementById('aiPanel')?.classList.contains('open')) return;
  clearTimeout(_geocodeTimer);
  _geocodeTimer = setTimeout(_aiUpdateLocation, 800); // chờ user dừng kéo 800ms mới gọi
});