/**
 * main.ts — GeoStory Vite entry point
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
const SERVER_ACCOUNT = import.meta.env.VITE_SHELBY_ACCOUNT_ADDRESS ?? "";


// Flag: auto-load đã complete chưa (tránh loadUserStories load lại lần 2)
let _autoLoadDone = false;
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
   HELPERS
════════════════════════════════════════ */
const getMetaMask = (): any => (window as any).ethereum ?? null;

function shortAddr(addr: string, len = 6): string {
  return addr.slice(0, len) + "..." + addr.slice(-4);
}
function S(): any { return (window as any).S; }
function toast(msg: string) { (window as any).toast?.(msg); }

/* ════════════════════════════════════════
   WALLET UI
════════════════════════════════════════ */
function setWalletUI(addr: string, type: "petra" | "metamask" | "demo") {
  const state = S();
  state.walletAddr = addr;
  state.walletType = type;
  const btn = document.getElementById("walletBtn")!;
  btn.textContent = shortAddr(addr);
  btn.className   = "connected";
  btn.onclick     = (window as any).toggleProfile;
  const profAddr = document.getElementById("profAddr");
  if (profAddr) profAddr.textContent = addr;
}

function clearWalletUI() {
  const btn = document.getElementById("walletBtn")!;
  btn.textContent = "CONNECT WALLET";
  btn.className   = "";
  btn.onclick     = () => (window as any).openModal("walletModal");
  const profAddr = document.getElementById("profAddr");
  if (profAddr) profAddr.textContent = "—";
}

/* ════════════════════════════════════════
   WALLET MODAL — dynamically rendered via AIP-62
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

  const wallets = getWalletListForUI();
  const demoOpt = container.querySelector('.wallet-opt[onclick*="demo"]');
  container.querySelectorAll(".wallet-opt, .wallet-section-title").forEach(el => el.remove());

  const aptosTitle = document.createElement("div");
  aptosTitle.className   = "wallet-section-title";
  aptosTitle.textContent = "APTOS WALLETS";
  container.appendChild(aptosTitle);

  const installUrls: Record<string, string> = {
    "Petra": "https://petra.app",
  };

  for (const w of wallets) {
    const div     = document.createElement("div");
    div.className = "wallet-opt" + (w.installed ? "" : " wallet-opt--uninstalled");

    const iconEl      = document.createElement("div");
    iconEl.className  = "wallet-icon";
    if (w.icon?.startsWith("data:")) {
      const img = document.createElement("img");
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
      ? () => (window as any).connectWallet(w.name)
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
  mmDiv.onclick    = () => (window as any).connectWallet("metamask");
  container.appendChild(mmDiv);

  if (demoOpt) {
    const sep = document.createElement("div");
    sep.className      = "wallet-section-title";
    sep.style.marginTop = "12px";
    sep.textContent    = "TESTNET";
    container.appendChild(sep);
    container.appendChild(demoOpt);
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
   Only retrieves wallet address — does NOT sign anything
════════════════════════════════════════ */
async function connectAptosWallet(walletName: string): Promise<void> {
  toast(`🔍 Looking for ${walletName}...`);
  const wallet = await waitForWallet(walletName, 3000);

  if (!wallet) {
    toast(`❌ ${walletName} is not installed`);
    const urls: Record<string, string> = {
      "Petra": "https://petra.app",
    };
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

    // Verify correct network (Testnet)
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
  await new Promise(r => setTimeout(r, 400));
  const addr = "0xDEMO_" + Math.random().toString(16).slice(2, 8).toUpperCase();
  setWalletUI(addr, "demo");
  toast("✅ Demo mode — data is stored temporarily only");
}

/* ════════════════════════════════════════
   DISCONNECT
════════════════════════════════════════ */
function doDisconnect(): void {
  const state = S();
  if (state.walletType === "petra" && _connectedWallet) {
    _connectedWallet.features["aptos:disconnect"]?.disconnect?.().catch(() => {});
    _connectedWallet = null;
  }
  state.walletAddr = null;
  state.walletType = null;
  // Ghi nhớ user đã chủ động đăng xuất — ngăn auto-reconnect khi reload
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
  // Nếu user đã chủ động đăng xuất trong session này → không auto-reconnect
  if (localStorage.getItem("geostory_disconnected") === "1") return;
  await new Promise(r => setTimeout(r, 300));
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
   window.shelby.upload
   All uploads go through the server.
   author = actual wallet address of the user (used for tipping later).
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
    wallet: string; // user wallet address
  }): Promise<{ cid: string; txHash?: string; imageUrl?: string }> => {

    // Validate image on client before sending
    if (data.image) {
      const commaIdx = data.image.indexOf(",");
      if (commaIdx === -1) throw new Error("Invalid image — please select again");
      // Estimate byte size from base64
      const b64Len   = data.image.length - commaIdx - 1;
      const sizeBytes = Math.ceil(b64Len * 3 / 4);
      if (sizeBytes > 3 * 1024 * 1024) throw new Error("Image must be under 3MB — please choose a smaller image");
    }

    // Send JSON directly — imageBase64 embedded inline, no multipart needed
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

    const res = await fetch("/api/stories", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
    });

    // Read as text first — avoids crash when server returns HTML or empty body
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
    const res  = await fetch("/api/stories");
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
  // Support both imageBase64 (new) and imageUrl (legacy)
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
    // Đợi auto-load boot hoàn thành trước (nếu đang chạy)
    if (_autoLoadPromise) await _autoLoadPromise;

    const state    = S();

    // Auto-load đã xong → chỉ update isOwn + re-render, KHÔNG fetch lại
    if (_autoLoadDone) {
      state.stories.forEach((s: any) => {
        s.isOwn = s.fullAddr?.toLowerCase() === address.toLowerCase();
      });
      (window as any).renderFeed?.();
      (window as any).renderMarkers?.();
      return;
    }

    // SERVER_ACCOUNT trống → tự fetch
    toast("⏳ Loading stories from Shelby...");
    const targetAccount = SERVER_ACCOUNT || address;
    const stories       = await loadStoriesFromShelby(targetAccount);

    if (!stories.length) { toast("📭 No stories found on Shelby"); return; }

    const existing = new Set(state.stories.map((s: any) => s.id));
    const merged   = stories.map(s => ({
      ...s,
      isOwn: s.fullAddr?.toLowerCase() === address.toLowerCase(),
    }));
    const fresh = merged.filter((s: any) => !existing.has(s.id));

    state.stories = [...fresh, ...state.stories];
    (window as any).renderMarkers?.();
    (window as any).renderFeed?.();
    (window as any).syncCount?.();
    const n = fresh.length;
    toast(`✅ Loaded ${n} stor${n === 1 ? "y" : "ies"} from Shelby`);
    setTimeout(() => (window as any).loadLikesForStories?.(), 500);

  } catch (err: any) {
    console.error("[GeoStory] loadUserStories:", err);
    toast("⚠ Could not load stories: " + (err?.message ?? err));
  }
}

/* ════════════════════════════════════════
   CONNECT WALLET ENTRY POINT
════════════════════════════════════════ */
async function _connectWalletReal(type: string): Promise<void> {
  // User chủ động connect → xóa flag đăng xuất
  localStorage.removeItem("geostory_disconnected");
  (window as any).closeModal?.("walletModal");
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
   EXPOSE
════════════════════════════════════════ */
(window as any).loadStoriesFromShelby     = loadStoriesFromShelby;
(window as any).loadUserStoriesFromShelby = loadUserStories;

/* ════════════════════════════════════════
   BOOT
════════════════════════════════════════ */
/* ════════════════════════════════════════
   BOOT
   - _autoLoadPromise: loadUserStories await trước khi quyết định fetch hay không
   - _autoLoadDone: flag để biết auto-load đã xong chưa
════════════════════════════════════════ */

// Auto-load stories — no wallet required
// Wrap trong Promise để loadUserStories có thể await
if (SERVER_ACCOUNT) {
  _autoLoadPromise = new Promise<void>(resolve => {
    setTimeout(async () => {
      toast("⏳ Loading stories from Shelby...");
      try {
        const res  = await fetch("/api/stories");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = JSON.parse(await res.text());
        if (Array.isArray(data.stories) && data.stories.length) {
          const state      = S();
          const walletAddr = state.walletAddr ?? "";
          const stories    = data.stories.map((s: any) => {
            const story = normalizeStory(s, SERVER_ACCOUNT);
            if (walletAddr) story.isOwn = story.fullAddr?.toLowerCase() === walletAddr.toLowerCase();
            return story;
          });
          const existing = new Set(state.stories.map((x: any) => x.id));
          const fresh    = stories.filter((s: any) => !existing.has(s.id));
          if (fresh.length) {
            state.stories = [...fresh, ...state.stories];
            (window as any).renderMarkers?.();
            (window as any).renderFeed?.();
            (window as any).syncCount?.();
            const n = fresh.length;
            toast(`✅ Loaded ${n} stor${n === 1 ? "y" : "ies"} from Shelby`);
            setTimeout(() => (window as any).loadLikesForStories?.(), 600);
          }
        }
      } catch (e) {
        console.warn("[GeoStory] Auto-load failed:", e);
      } finally {
        _autoLoadDone = true; // done dù thành công hay lỗi
        resolve();
      }
    }, 2000);
  });
} else {
  _autoLoadDone = true; // không có SERVER_ACCOUNT → skip luôn
}

// tryAutoReconnect chạy sau — loadUserStories sẽ await _autoLoadPromise
// nên không bao giờ fetch lại khi auto-load đang chạy
setTimeout(tryAutoReconnect, 2500);

console.log("[GeoStory] main.ts ready — wallet = identity only, upload = server");