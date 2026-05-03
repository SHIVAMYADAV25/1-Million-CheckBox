/**
 * 1 Million Checkboxes — Frontend
 *
 * FIXES:
 * 1. Canvas fills full remaining viewport height properly
 * 2. Grid lines drawn in a single path pass (fast + visible)
 * 3. Scroll uses window.scrollY + translates draw position
 * 4. alpha:false on canvas context = faster compositing
 */

const CHECKBOX_COUNT = 1_000_000;

const ZOOM_LEVELS = [
  ["Tiny",   6],
  ["Small",  10],
  ["Medium", 16],
  ["Large",  22],
  ["Huge",   30],
];
const DEFAULT_ZOOM = 2;

const C_BG          = "#F7F3EE";
const C_BORDER      = "#C8BFB3";
const C_CHECKED     = "#9B4A2A";
const C_HOVER       = "#EDD9CE";
const C_CHK_HOVER   = "#C4673D";

// ── State ──────────────────────────────────────────────────
const S = {
  bits:            new Uint8Array(Math.ceil(CHECKBOX_COUNT / 8)),
  zoomIndex:       DEFAULT_ZOOM,
  cellSize:        ZOOM_LEVELS[DEFAULT_ZOOM][1],
  cols:            0,
  totalRows:       0,
  canvasW:         0,
  canvasH:         0,
  hoverIndex:      -1,
  pendingDraw:     new Set(),
  isAuthenticated: false,
  user:            null,
  accessToken:     null,
};

// ── DOM ────────────────────────────────────────────────────
const canvas       = document.getElementById("grid-canvas");
const ctx          = canvas.getContext("2d", { alpha: false });
const hitArea      = document.getElementById("hit-area");
const loadScreen   = document.getElementById("loading-screen");
const statChecked  = document.getElementById("stat-checked");
const progressFill = document.getElementById("progress-fill");
const progressLbl  = document.getElementById("progress-label");
const connBadge    = document.getElementById("conn-badge");
const connText     = document.getElementById("conn-text");
const zoomLabel    = document.getElementById("zoom-label");
const btnLogin     = document.getElementById("btn-login");
const userPill     = document.getElementById("user-pill");
const userAvatar   = document.getElementById("user-avatar");
const userName     = document.getElementById("user-name");
const anonBanner   = document.getElementById("anon-banner");
const toast        = document.getElementById("toast");

// ── Bitmask ────────────────────────────────────────────────
const getBit = (arr, i) => (arr[i >> 3] >> (7 - (i & 7))) & 1;
function setBit(arr, i, v) {
  const byte = i >> 3, bit = 7 - (i & 7);
  if (v) arr[byte] |= (1 << bit); else arr[byte] &= ~(1 << bit);
}
function countBits(arr) {
  let n = 0;
  for (let i = 0; i < arr.length; i++) {
    let b = arr[i];
    b = b - ((b >> 1) & 0x55);
    b = (b & 0x33) + ((b >> 2) & 0x33);
    n += (b + (b >> 4)) & 0x0F;
  }
  return n;
}

// ── Layout ─────────────────────────────────────────────────
function recalcLayout() {
  const cs = S.cellSize;
  const vw = window.innerWidth;

  // Measure how far from top the canvas actually sits
  // (header 68px + toolbar 48px + banner if visible)
  const bannerH = anonBanner.classList.contains("hidden") ? 0 : anonBanner.offsetHeight;
  const topUsed = 68 + 48 + bannerH;
  const vh = window.innerHeight - topUsed;

  S.cols      = Math.max(1, Math.floor(vw / cs));
  S.totalRows = Math.ceil(CHECKBOX_COUNT / S.cols);
  S.canvasW   = S.cols * cs;
  S.canvasH   = Math.max(vh, 200);

  // Set the sticky container height so it fills exactly the remaining space
  const sticky = document.getElementById("canvas-sticky");
  if (sticky) sticky.style.height = S.canvasH + "px";

  canvas.width  = S.canvasW;
  canvas.height = S.canvasH;
  canvas.style.width  = S.canvasW + "px";
  canvas.style.height = S.canvasH + "px";

  hitArea.style.width  = S.canvasW + "px";
  hitArea.style.height = S.canvasH + "px";

  // Spacer drives window scroll height
  const totalH = S.totalRows * cs;
  const spacer = document.getElementById("scroll-spacer");
  if (spacer) spacer.style.height = Math.max(0, totalH - S.canvasH) + "px";
}

// ── Draw all ───────────────────────────────────────────────
function drawAll() {
  const cs        = S.cellSize;
  const cols      = S.cols;
  const scrollTop = window.scrollY;
  const firstRow  = Math.floor(scrollTop / cs);
  const visRows   = Math.ceil(S.canvasH / cs) + 2;

  // Fill background
  ctx.fillStyle = C_BG;
  ctx.fillRect(0, 0, S.canvasW, S.canvasH);

  // Checked and hover cells
  for (let r = firstRow; r < firstRow + visRows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (idx >= CHECKBOX_COUNT) break;

      const checked = getBit(S.bits, idx);
      const hover   = S.hoverIndex === idx;

      if (checked || hover) {
        ctx.fillStyle = checked
          ? (hover ? C_CHK_HOVER : C_CHECKED)
          : C_HOVER;
        ctx.fillRect(c * cs, (r - firstRow) * cs, cs, cs);
      }
    }
  }

  // Checkmarks
  if (cs >= 10) {
    ctx.strokeStyle = "#fff";
    ctx.lineWidth   = cs < 14 ? 1.2 : 1.8;
    ctx.lineCap     = "round";
    ctx.lineJoin    = "round";
    for (let r = firstRow; r < firstRow + visRows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        if (idx >= CHECKBOX_COUNT) break;
        if (!getBit(S.bits, idx)) continue;
        const x = c * cs, y = (r - firstRow) * cs, pad = cs * 0.22;
        ctx.beginPath();
        ctx.moveTo(x + pad,       y + cs * 0.52);
        ctx.lineTo(x + cs * 0.38, y + cs * 0.62);
        ctx.lineTo(x + cs - pad,  y + pad);
        ctx.stroke();
      }
    }
  } else {
    // Tiny dot
    ctx.fillStyle = "#fff";
    const s = Math.max(cs * 0.3, 1.5);
    for (let r = firstRow; r < firstRow + visRows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        if (idx >= CHECKBOX_COUNT) break;
        if (!getBit(S.bits, idx)) continue;
        ctx.fillRect(c * cs + (cs - s) / 2, (r - firstRow) * cs + (cs - s) / 2, s, s);
      }
    }
  }

  // Grid lines — single path, single stroke call
  ctx.strokeStyle = C_BORDER;
  ctx.lineWidth   = 0.5;
  ctx.beginPath();
  for (let c = 0; c <= cols; c++) {
    const x = c * cs + 0.5;
    ctx.moveTo(x, 0); ctx.lineTo(x, S.canvasH);
  }
  for (let r = 0; r <= visRows; r++) {
    const y = r * cs + 0.5;
    ctx.moveTo(0, y); ctx.lineTo(S.canvasW, y);
  }
  ctx.stroke();
}

// ── Draw single cell ───────────────────────────────────────
function drawCell(idx) {
  const cs      = S.cellSize;
  const col     = idx % S.cols;
  const row     = Math.floor(idx / S.cols);
  const firstRow = Math.floor(window.scrollY / cs);
  const sy       = row - firstRow;
  if (sy < 0 || sy > Math.ceil(S.canvasH / cs) + 1) return;

  const x = col * cs, y = sy * cs;
  const checked = getBit(S.bits, idx);
  const hover   = S.hoverIndex === idx;

  ctx.fillStyle = checked
    ? (hover ? C_CHK_HOVER : C_CHECKED)
    : (hover ? C_HOVER     : C_BG);
  ctx.fillRect(x, y, cs, cs);

  if (checked && cs >= 10) {
    const pad = cs * 0.22;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth   = cs < 14 ? 1.2 : 1.8;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(x + pad,       y + cs * 0.52);
    ctx.lineTo(x + cs * 0.38, y + cs * 0.62);
    ctx.lineTo(x + cs - pad,  y + pad);
    ctx.stroke();
  } else if (checked) {
    const s = Math.max(cs * 0.3, 1.5);
    ctx.fillStyle = "#fff";
    ctx.fillRect(x + (cs - s) / 2, y + (cs - s) / 2, s, s);
  }

  ctx.strokeStyle = C_BORDER;
  ctx.lineWidth   = 0.5;
  ctx.strokeRect(x + 0.5, y + 0.5, cs - 1, cs - 1);
}

// ── RAF batch ──────────────────────────────────────────────
let rafPending = false;
function scheduleRedraw() {
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      S.pendingDraw.forEach(drawCell);
      S.pendingDraw.clear();
    });
  }
}

// ── Scroll ─────────────────────────────────────────────────
let scrollRaf = false;
window.addEventListener("scroll", () => {
  if (!scrollRaf) { scrollRaf = true; requestAnimationFrame(() => { scrollRaf = false; drawAll(); }); }
}, { passive: true });

// ── Hit test ───────────────────────────────────────────────
function eventToIndex(e) {
  const r = canvas.getBoundingClientRect();
  const cs = S.cellSize;
  const col = Math.floor((e.clientX - r.left) / cs);
  const row = Math.floor((e.clientY - r.top)  / cs);
  if (col < 0 || col >= S.cols || row < 0) return -1;
  const idx = (Math.floor(window.scrollY / cs) + row) * S.cols + col;
  return (idx >= 0 && idx < CHECKBOX_COUNT) ? idx : -1;
}

hitArea.addEventListener("click", e => {
  if (!S.isAuthenticated) { showToast("Sign in to toggle checkboxes.", "error"); anonBanner.classList.remove("hidden"); return; }
  const idx = eventToIndex(e); if (idx === -1) return;
  const next = !getBit(S.bits, idx);
  setBit(S.bits, idx, next);
  drawCell(idx); updateStats();
  socket.emit("client:checkbox:change", { index: idx, checked: next });
});

hitArea.addEventListener("mousemove", e => {
  const idx = eventToIndex(e); if (idx === S.hoverIndex) return;
  const prev = S.hoverIndex; S.hoverIndex = idx;
  if (prev !== -1) drawCell(prev); if (idx !== -1) drawCell(idx);
});
hitArea.addEventListener("mouseleave", () => { const p = S.hoverIndex; S.hoverIndex = -1; if (p !== -1) drawCell(p); });

// ── Zoom ───────────────────────────────────────────────────
window.changeZoom = delta => {
  const n = S.zoomIndex + delta;
  if (n < 0 || n >= ZOOM_LEVELS.length) return;
  S.zoomIndex = n; S.cellSize = ZOOM_LEVELS[n][1];
  zoomLabel.textContent = ZOOM_LEVELS[n][0];
  recalcLayout(); drawAll();
};

// ── Jump to ────────────────────────────────────────────────
window.jumpToBox = () => {
  const num = parseInt(document.getElementById("jump-input").value, 10);
  if (isNaN(num) || num < 1 || num > CHECKBOX_COUNT) { showToast("Enter 1–1,000,000.", "error"); return; }
  const row = Math.floor((num - 1) / S.cols);
  window.scrollTo({ top: Math.max(0, row * S.cellSize - S.canvasH / 2), behavior: "smooth" });
  setTimeout(() => { S.hoverIndex = num - 1; drawCell(num - 1); setTimeout(() => { S.hoverIndex = -1; drawCell(num - 1); }, 900); }, 350);
};

// ── Stats ──────────────────────────────────────────────────
let statsT = 0;
function updateStats() {
  const now = Date.now(); if (now - statsT < 400) return; statsT = now;
  const checked = countBits(S.bits), pct = (checked / CHECKBOX_COUNT * 100).toFixed(2);
  statChecked.textContent  = checked.toLocaleString();
  progressFill.style.width = pct + "%";
  progressLbl.textContent  = pct + "%";
}

// ── Conn badge ─────────────────────────────────────────────
function setConnState(s) {
  connBadge.className  = "connection-badge " + s;
  connText.textContent = s === "connected" ? "Live" : s === "disconnected" ? "Offline" : "Connecting";
}

// ── Toast ──────────────────────────────────────────────────
let toastT = null;
function showToast(msg, type = "info") {
  toast.textContent = msg; toast.className = `toast ${type}`;
  if (toastT) clearTimeout(toastT);
  toastT = setTimeout(() => { toast.className = "toast hidden"; }, 3500);
}

// ── Socket ─────────────────────────────────────────────────
const socket = io({ auth: { token: S.accessToken } });
socket.on("connect",       () => setConnState("connected"));
socket.on("disconnect",    () => setConnState("disconnected"));
socket.on("connect_error", () => setConnState("disconnected"));
socket.on("server:checkbox:change", ({ index, checked }) => {
  if (index < 0 || index >= CHECKBOX_COUNT) return;
  setBit(S.bits, index, checked ? 1 : 0);
  S.pendingDraw.add(index); scheduleRedraw(); updateStats();
});
socket.on("server:error", ({ code, message }) => { showToast(message || "Error.", "error"); if (code === "RATE_LIMITED") drawAll(); });

// ── Auth ───────────────────────────────────────────────────
function checkAuthOnLoad() {
  const p = new URLSearchParams(window.location.search);
  if (p.get("error")) showToast("Authentication failed.", "error");
  const token = p.get("token");
  if (token) {
    S.accessToken = token;
    window.history.replaceState({}, "", window.location.pathname);
    socket.auth = { token }; socket.disconnect().connect();
    fetchCurrentUser();
  } else { tryTokenRefresh(); }
}
async function fetchCurrentUser() {
  try {
    const r = await fetch("/auth/me", { headers: { Authorization: `Bearer ${S.accessToken}` } });
    if (!r.ok) throw 0;
    setUser((await r.json()).user);
  } catch { setUser(null); }
}
async function tryTokenRefresh() {
  try {
    const r = await fetch("/auth/refresh", { method: "POST" });
    if (!r.ok) return;
    S.accessToken = (await r.json()).accessToken;
    socket.auth = { token: S.accessToken }; socket.disconnect().connect();
    fetchCurrentUser();
  } catch { /* anonymous */ }
}
function setUser(user) {
  S.user = user; S.isAuthenticated = !!user;
  if (user) {
    const initials = (user.name || user.email || "?").split(/\s+/).map(w => w[0]).slice(0,2).join("").toUpperCase();
    userAvatar.textContent = initials; userName.textContent = user.name || user.email || "User";
    btnLogin.classList.add("hidden"); userPill.classList.remove("hidden"); anonBanner.classList.add("hidden");
    showToast(`Welcome, ${user.name || "there"}!`, "success");
  } else {
    btnLogin.classList.remove("hidden"); userPill.classList.add("hidden");
    if (!sessionStorage.getItem("banner_dismissed")) anonBanner.classList.remove("hidden");
  }
}
window.handleLogin  = () => { window.location.href = "/auth/login"; };
window.handleLogout = async () => {
  await fetch("/auth/logout", { method: "POST" });
  S.accessToken = null; S.user = null; S.isAuthenticated = false; setUser(null);
  showToast("Signed out.", "success");
};
window.dismissBanner = () => { anonBanner.classList.add("hidden"); sessionStorage.setItem("banner_dismissed","1"); recalcLayout(); drawAll(); };

// ── Resize ─────────────────────────────────────────────────
let resizeT = null;
window.addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => { recalcLayout(); drawAll(); }, 60); });

// ── Init ───────────────────────────────────────────────────
async function init() {
  checkAuthOnLoad();
  zoomLabel.textContent = ZOOM_LEVELS[DEFAULT_ZOOM][0];
  await new Promise(r => requestAnimationFrame(r)); // wait one frame for layout
  recalcLayout();
  drawAll(); // show empty grid immediately

  try {
    const res = await fetch("/api/checkboxes");
    const data = await res.json();
    if (data.state) {
      const bin = atob(data.state), buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      S.bits = buf;
    }
    try {
      const sr = await fetch("/api/stats");
      if (sr.ok) {
        const { checked } = await sr.json();
        const pct = (checked / CHECKBOX_COUNT * 100).toFixed(2);
        statChecked.textContent = checked.toLocaleString();
        progressFill.style.width = pct + "%"; progressLbl.textContent = pct + "%";
      }
    } catch { updateStats(); }
  } catch (err) {
    console.error("[init]", err);
    showToast("Failed to load state. Refresh to retry.", "error");
  }

  loadScreen.classList.add("hidden");
  drawAll();
}

init();