import crypto from "crypto";
import fs from "fs";
import path from "path";

import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";

import {
  Account,
  AccountAddress,
  Aptos,
  AptosConfig,
  Ed25519PrivateKey,
  Network,
} from "@aptos-labs/ts-sdk";

import { ShelbyNodeClient } from "@shelby-protocol/sdk/node";

// ─── App setup ───────────────────────────────────────────────────────────────

const app = express();

app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  handler: (_req, res) => {
    res.status(429).json({ error: "I'm tired now, let's meet tomorrow. 😅" });
  },
});
app.use("/api/ai", aiLimiter);

// ─── Env validation ──────────────────────────────────────────────────────────

if (!process.env.VITE_SHELBY_API_KEY)
  throw new Error("Missing VITE_SHELBY_API_KEY");
if (!process.env.VITE_SHELBY_ACCOUNT_PRIVATE_KEY)
  throw new Error("Missing VITE_SHELBY_ACCOUNT_PRIVATE_KEY");
if (!process.env.VITE_SHELBY_ACCOUNT_ADDRESS)
  throw new Error("Missing VITE_SHELBY_ACCOUNT_ADDRESS");

// ─── Shelby client ───────────────────────────────────────────────────────────

const shelbyClient = new ShelbyNodeClient({
  network: Network.TESTNET,
  apiKey:  process.env.VITE_SHELBY_API_KEY,
});

const signer = Account.fromPrivateKey({
  privateKey: new Ed25519PrivateKey(process.env.VITE_SHELBY_ACCOUNT_PRIVATE_KEY),
});

const SHELBY_BASE =
  "https://api.testnet.shelby.xyz/shelby/v1/blobs/" +
  process.env.VITE_SHELBY_ACCOUNT_ADDRESS + "/";

const TIME_TO_LIVE = 365 * 24 * 60 * 60 * 1_000_000;

// ─── Subscriptions config ────────────────────────────────────────────────────
// Payment collected in APT (testnet) for now. Once shelbyUSD's coin/FA address
// is available, only PAY_COIN_TYPE + the amount-matching logic in
// POST /api/subscribe need to change — everything else stays the same.

const aptos = new Aptos(new AptosConfig({ network: Network.TESTNET }));

const PAY_COIN_TYPE  = "0x1::aptos_coin::AptosCoin";
const OCTAS_PER_APT  = 100_000_000;
const TREASURY_ADDRESS = "0x2a2b71eb64838441b6bb408913cacd6d04f517fac1e187f7c346931f35b32775";

type TierName = "free" | "pro" | "premium";

const PRICING: Record<Exclude<TierName, "free">, { apt: number; days: number; aiCreditsPerDay: number | null }> = {
  pro:     { apt: 5,  days: 30, aiCreditsPerDay: 20 },
  premium: { apt: 15, days: 30, aiCreditsPerDay: null }, // null = unlimited
};

const FREE_STORIES_PER_DAY = 5;

// ─── Advertiser pricing (draft defaults — adjust anytime) ──────────────────
// Not wired to routes yet (campaign creation/review/payment still pending);
// these numbers just unblock the rest of the design.
const AD_PRICING = {
  mapPin:  { aptPerDay: 2   }, // Sponsored Pin on the map
  feedPin: { aptPerDay: 1.5 }, // Pinned to top of feed
  combo:   { aptPerDay: 3   }, // both placements, discounted vs 3.5 apt/day combined
};

// ─── Feed reach radius (km) ──────────────────────────────────────────────────
// Only meaningful for "feed" / "combo" placements: a feed ad is only shown to
// viewers whose current map view is within `radiusKm` of the pin. Wider reach
// costs more — the multiplier is applied on top of the placement's aptPerDay.
const AD_RADIUS_OPTIONS = [5, 20, 50, 100, 300] as const;
const DEFAULT_AD_RADIUS_KM = 20;

function radiusMultiplier(radiusKm: number): number {
  if (radiusKm <= 5)   return 1;
  if (radiusKm <= 20)  return 1.3;
  if (radiusKm <= 50)  return 1.6;
  if (radiusKm <= 100) return 2;
  return 2.5; // > 100km ("nationwide" tier)
}

// ─── Stories cache (in-memory, TTL 60s) ─────────────────────────────────────
let _storiesCache: { stories: unknown[]; ts: number } | null = null;
const STORIES_CACHE_TTL = 60_000;

function getCachedStories(): unknown[] | null {
  if (!_storiesCache) return null;
  if (Date.now() - _storiesCache.ts > STORIES_CACHE_TTL) return null;
  return _storiesCache.stories;
}
function setCachedStories(stories: unknown[]) {
  _storiesCache = { stories, ts: Date.now() };
}
function invalidateStoriesCache() {
  _storiesCache = null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function randomId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function expiresAt(): number {
  return Date.now() * 1000 + TIME_TO_LIVE;
}

async function shelbyFetchJSON<T = any>(
  blobName: string,
  timeoutMs = 6000
): Promise<T | null> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(SHELBY_BASE + blobName, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return null;
    const text = await r.text();
    const data = JSON.parse(text);
    if (data?.error) return null;
    return data as T;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

async function shelbyUpload(blobName: string, payload: unknown): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  await shelbyClient.upload({
    blobData:         bytes,
    signer,
    blobName,
    expirationMicros: expiresAt(),
  });
}

// ─── Versioned blobs (cho dữ liệu bị GHI ĐÈ nhiều lần: sub theo wallet,
// comments theo story, ads index, used-tx-hashes...) ────────────────────────
// Shelby không cho ghi đè nội dung mới lên một blobName đã tồn tại:
// ShelbyNodeClient.upload() chỉ đăng ký merkle-root on-chain khi blobName
// CHƯA có; nếu đã có, nó bỏ qua đăng ký và chạy multipart-upload thẳng lên
// RPC — nội dung mới sẽ không khớp root cũ đã đăng ký ở lần đầu, khiến bước
// "complete multipart upload" luôn trả 400 Bad Request.
//
// Giải pháp: mỗi lần ghi, dùng blobName MỚI = `${key}_${timestamp}_${random}`
// (đúng như đã làm với "geostory_post_"). Khi cần đọc lại, KHÔNG cần lưu con
// trỏ ở đâu cả — chỉ cần liệt kê blob của account rồi lọc theo tiền tố `key`,
// lấy bản có timestamp mới nhất. Đây là chính xác cách code đã làm để liệt
// kê stories (`blobNameSuffix.startsWith("geostory_post_")`), chỉ khác là ở
// đây ta chỉ lấy 1 bản mới nhất thay vì tất cả.

function randomSuffix(len = 6): string {
  return crypto.randomBytes(len).toString("hex");
}

async function shelbyUploadVersioned(key: string, payload: unknown): Promise<string> {
  const blobName = `${key}_${Date.now()}_${randomSuffix()}`;
  await shelbyUpload(blobName, payload);
  return blobName;
}

async function shelbyFetchVersioned<T = any>(key: string, timeoutMs = 6000): Promise<T | null> {
  const address = process.env.VITE_SHELBY_ACCOUNT_ADDRESS!;
  const account = AccountAddress.fromString(address);

  let blobs: Awaited<ReturnType<typeof shelbyClient.coordination.getAccountBlobs>>;
  try {
    blobs = await shelbyClient.coordination.getAccountBlobs({ account });
  } catch (err) {
    console.error(`[shelbyFetchVersioned] could not list blobs for prefix "${key}":`, err);
    // fallback: may be old data written before this patch, under the fixed key itself
    return shelbyFetchJSON<T>(key, timeoutMs);
  }

  const matches = blobs.filter(b => b.blobNameSuffix.startsWith(key + "_"));
  if (matches.length === 0) {
    // fallback: dữ liệu ghi trước khi có patch này vẫn nằm ở key cố định cũ
    return shelbyFetchJSON<T>(key, timeoutMs);
  }

  matches.sort((a, b) => b.creationMicros - a.creationMicros); // mới nhất trước
  return shelbyFetchJSON<T>(matches[0].blobNameSuffix, timeoutMs);
}

// ─── Retry + fallback queue cho Shelby ──────────────────────────────────────
// Dùng riêng cho các trường hợp SAU KHI thanh toán on-chain đã được xác minh
// thành công (tiền đã trừ trong ví người dùng). Ở điểm này ta KHÔNG được phép
// chỉ trả lỗi cho client rồi bỏ qua — nếu làm vậy, người dùng mất tiền mà
// không có gói/campaign nào được kích hoạt. Thay vào đó:
//   1. Thử lại upload lên Shelby vài lần (backoff tăng dần).
//   2. Nếu vẫn thất bại, ghi vào file hàng đợi cục bộ (pending-shelby-writes.json)
//      kèm txHash, rồi có một job nền định kỳ thử lại cho tới khi thành công.
// Nhờ vậy dữ liệu luôn được đối chiếu lại được với giao dịch on-chain, kể cả
// khi Shelby tạm thời gặp sự cố.

async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 800): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise(r => setTimeout(r, baseDelayMs * Math.pow(2, i)));
      }
    }
  }
  throw lastErr;
}

interface PendingWrite {
  id: string;
  blobName: string; // logical key (versioned blob will be created under this key)
  payload: unknown;
  txHash: string;
  kind: "subscribe" | "ads";
  createdAt: number;
  attempts: number;
}

const PENDING_QUEUE_FILE = path.join(process.cwd(), "pending-shelby-writes.json");

function loadPendingQueue(): PendingWrite[] {
  try {
    if (!fs.existsSync(PENDING_QUEUE_FILE)) return [];
    return JSON.parse(fs.readFileSync(PENDING_QUEUE_FILE, "utf8"));
  } catch {
    return [];
  }
}

function savePendingQueue(queue: PendingWrite[]): void {
  try {
    fs.writeFileSync(PENDING_QUEUE_FILE, JSON.stringify(queue, null, 2));
  } catch (err) {
    console.error("[pending-shelby-writes] could not persist queue file:", err);
  }
}

function enqueuePendingWrite(entry: Omit<PendingWrite, "id" | "createdAt" | "attempts">): void {
  const queue = loadPendingQueue();
  queue.push({ ...entry, id: crypto.randomUUID(), createdAt: Date.now(), attempts: 0 });
  savePendingQueue(queue);
  console.error(
    `[pending-shelby-writes] ⚠ Đã xác nhận thanh toán on-chain (txHash=${entry.txHash}) nhưng` +
    ` lưu Shelby thất bại — đưa vào hàng đợi để tự động thử lại. Blob: ${entry.blobName}`
  );
}

// Job nền: mỗi 30 giây thử ghi lại các bản ghi còn tồn đọng trong hàng đợi.
async function processPendingQueue(): Promise<void> {
  const queue = loadPendingQueue();
  if (queue.length === 0) return;

  const stillPending: PendingWrite[] = [];
  for (const item of queue) {
    try {
      await shelbyUploadVersioned(item.blobName, item.payload);
      console.error(`[pending-shelby-writes] ✅ Đã lưu lại thành công blob ${item.blobName} (txHash=${item.txHash})`);
      // Đồng bộ lại cache trong bộ nhớ nếu cần
      if (item.kind === "subscribe") {
        const sub = item.payload as Subscription;
        subsCache.set(sub.wallet.toLowerCase(), sub);
      } else if (item.kind === "ads") {
        const ad = item.payload as AdCampaign;
        adsCache.set(ad.id, ad);
        adsIndex.add(ad.id);
        await withRetry(() => shelbyUploadVersioned("geostory_ads_index", { ids: [...adsIndex] }), 2).catch(() => {});
      }
      await withRetry(() => markTxHashUsed(item.txHash), 2).catch(() => {});
    } catch (err) {
      item.attempts += 1;
      if (item.attempts < 20) {
        stillPending.push(item);
      } else {
        console.error(`[pending-shelby-writes] ❌ Bỏ cuộc sau 20 lần thử — cần kiểm tra thủ công. txHash=${item.txHash}, blob=${item.blobName}`);
      }
    }
  }
  savePendingQueue(stillPending);
}

setInterval(() => { processPendingQueue().catch(err => console.error("[pending-shelby-writes] job error:", err)); }, 30_000);

// ─── Chống race-condition cho txHash ────────────────────────────────────────
// Bug thường gặp nhất trong luồng "verify on-chain rồi mới persist": nếu
// client gửi trùng request (double-click nút, mạng lag rồi retry, tab bị
// mở 2 lần...) với CÙNG 1 txHash, cả 2 request có thể cùng vượt qua bước
// kiểm tra "txHash đã dùng chưa" TRƯỚC KHI request đầu tiên kịp gọi
// markTxHashUsed() để đánh dấu — dẫn tới việc 1 giao dịch on-chain bị xử lý
// (persist) 2 lần. Giải pháp chuẩn: khoá txHash ngay khi bắt đầu xử lý
// (trong bộ nhớ, đồng bộ tuyệt đối vì Node.js single-threaded), giải khoá
// khi xong hoặc lỗi.
const txHashLocks = new Set<string>();

async function withTxHashLock<T>(txHash: string, fn: () => Promise<T>): Promise<T | { locked: true }> {
  if (txHashLocks.has(txHash)) return { locked: true };
  txHashLocks.add(txHash);
  try {
    return await fn();
  } finally {
    txHashLocks.delete(txHash);
  }
}

// ─── Content moderation (OpenAI Moderation API) ─────────────────────────────
// Checked before a story ever gets to shelbyUpload — text (title+description)
// and image (if present) go through the same call. If OPENAI_API_KEY isn't
// set, we fail-open (allow posting) but log loudly so it doesn't go unnoticed.
//
// Defense-in-depth: relying solely on `result.flagged` from the Moderation API
// missed obvious cases — e.g. a title containing "sex" doesn't always trip
// OpenAI's own `flagged` boolean (its thresholds are tuned for genuinely
// explicit/graphic content, not just a keyword appearing). So on top of the
// API call we ALSO run:
//   1. A curated keyword blocklist (title/description) — catches explicit
//      terms regardless of what the API decides, and still works even when
//      OPENAI_API_KEY is missing (previously that case skipped moderation
//      entirely).
//   2. A lower manual threshold on the API's own category_scores for the
//      sensitive categories, since the raw `flagged` boolean alone can miss
//      borderline content.

interface ModerationResult { flagged: boolean; categories: string[] }

// Word-boundary matched, case-insensitive. Deliberately narrow (avoids false
// positives like "Sussex"/"Essex") but covers the explicit terms most likely
// to slip past a generic moderation model when used as a title/description.
const EXPLICIT_KEYWORD_PATTERNS: RegExp[] = [
  /\bsex\b/i, /\bsexy\b/i, /\bsex\s*tape\b/i,
  /\bporn\w*\b/i, /\bxxx\b/i, /\bnsfw\b/i,
  /\bnude\b/i, /\bnaked\b/i, /\bescort\b/i, /\bonlyfans\b/i, /\bhentai\b/i,
  /khiêu\s*dâm/i, /mại\s*dâm/i, /gái\s*gọi/i, /lộ\s*hàng/i, /clip\s*nóng/i,
];

function findExplicitKeywords(text: string): string[] {
  const hits: string[] = [];
  for (const re of EXPLICIT_KEYWORD_PATTERNS) {
    const m = text.match(re);
    if (m) hits.push(m[0].toLowerCase());
  }
  return hits;
}

// Categories worth flagging even below OpenAI's own "flagged" threshold.
const SENSITIVE_SCORE_THRESHOLD = 0.25;
const SENSITIVE_SCORE_CATEGORIES = /sexual|violence|harassment|hate|self-harm/;

async function moderateContent(text: string, imageDataUrl?: string): Promise<ModerationResult> {
  const keywordHits = findExplicitKeywords(text ?? "");

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    if (keywordHits.length) {
      console.warn("[moderation] OPENAI_API_KEY not set — blocked by keyword fallback:", keywordHits);
      return { flagged: true, categories: ["explicit_keyword"] };
    }
    console.warn("[moderation] OPENAI_API_KEY not set — skipping AI content moderation check (keyword fallback only)");
    return { flagged: false, categories: [] };
  }

  const input: any[] = [];
  if (text?.trim()) input.push({ type: "text", text: text.trim() });
  if (imageDataUrl) input.push({ type: "image_url", image_url: { url: imageDataUrl } });
  if (input.length === 0) {
    return keywordHits.length
      ? { flagged: true, categories: ["explicit_keyword"] }
      : { flagged: false, categories: [] };
  }

  // 429 (rate limit) và 5xx là lỗi TẠM THỜI — trước đây bất kỳ lỗi HTTP nào
  // cũng khiến hàm fail-open ngay lập tức (coi như nội dung sạch), nghĩa là
  // khi OpenAI bị rate-limit, MỌI bài đăng — kể cả ảnh/tiêu đề nhạy cảm —
  // đều lọt qua mà không hề được kiểm duyệt. Giờ thử lại vài lần trước khi
  // chấp nhận fail-open, để rate-limit thoáng qua không làm mất kiểm duyệt.
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch("https://api.openai.com/v1/moderations", {
        method:  "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body:    JSON.stringify({ model: "omni-moderation-latest", input }),
      });

      if (res.ok) {
        const data   = await res.json();
        const result = data?.results?.[0];
        if (!result) {
          return keywordHits.length
            ? { flagged: true, categories: ["explicit_keyword"] }
            : { flagged: false, categories: [] };
        }

        const trueCategories = Object.entries(result.categories ?? {})
          .filter(([, v]) => v === true)
          .map(([k]) => k);

        const scores: Record<string, number> = result.category_scores ?? {};
        const scoreFlaggedCategories = Object.entries(scores)
          .filter(([cat, score]) => Number(score) >= SENSITIVE_SCORE_THRESHOLD && SENSITIVE_SCORE_CATEGORIES.test(cat))
          .map(([cat]) => cat);

        const categories = [...new Set([
          ...trueCategories,
          ...scoreFlaggedCategories,
          ...(keywordHits.length ? ["explicit_keyword"] : []),
        ])];

        const flagged = result.flagged === true || scoreFlaggedCategories.length > 0 || keywordHits.length > 0;
        return { flagged, categories };
      }

      const bodyText = await res.text().catch(() => "");
      const retryable = res.status === 429 || res.status >= 500;
      console.error(`[moderation] OpenAI API error (attempt ${attempt}/${MAX_ATTEMPTS}):`, res.status, bodyText);

      if (retryable && attempt < MAX_ATTEMPTS) {
        const retryAfterHeader = Number(res.headers.get("retry-after"));
        const delayMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
          ? retryAfterHeader * 1000
          : 500 * 2 ** (attempt - 1); // 500ms, 1000ms, ...
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }

      // Non-retryable error (4xx other than 429), or attempts exhausted.
      console.error("[moderation] giving up on AI check (fail-open for AI, keyword fallback still applies). Investigate OPENAI_API_KEY / rate limits.");
      return keywordHits.length
        ? { flagged: true, categories: ["explicit_keyword"] }
        : { flagged: false, categories: [] };

    } catch (err) {
      console.error(`[moderation] request failed (attempt ${attempt}/${MAX_ATTEMPTS}):`, err);
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, 500 * 2 ** (attempt - 1)));
        continue;
      }
      // fail-open for the AI check after exhausting retries; keyword fallback still applies
      return keywordHits.length
        ? { flagged: true, categories: ["explicit_keyword"] }
        : { flagged: false, categories: [] };
    }
  }

  return keywordHits.length
    ? { flagged: true, categories: ["explicit_keyword"] }
    : { flagged: false, categories: [] };
}

// ─── Ping ────────────────────────────────────────────────────────────────────

app.get("/api/ping", (_req, res) => {
  console.log("ping");
  res.send("pong");
});

// ─── POST /api/stories ───────────────────────────────────────────────────────

app.post("/api/stories", async (req, res) => {
  try {
    const {
      title,
      description,
      lat,
      lng,
      mood,
      category,
      author,
      imageBase64: rawImage,
    } = req.body;

    if (!title?.trim()) {
      return res.status(400).json({ error: "Missing or empty title" });
    }
    if (lat == null || lng == null) {
      return res.status(400).json({ error: "Missing location on the map" });
    }

    let validatedImage: string | undefined;
    if (rawImage) {
      if (typeof rawImage !== "string") {
        return res.status(400).json({ error: "imageBase64 must be a string" });
      }
      const commaIdx = rawImage.indexOf(",");
      if (commaIdx === -1) {
        return res.status(400).json({ error: "Invalid base64 image" });
      }
      const mime         = rawImage.slice(5, commaIdx).split(";")[0];
      const allowedTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];
      if (!allowedTypes.includes(mime)) {
        return res.status(400).json({ error: "Unsupported file types: " + mime });
      }
      const b64Len    = rawImage.length - commaIdx - 1;
      const sizeBytes = Math.ceil(b64Len * 3 / 4);
      if (sizeBytes > 3 * 1024 * 1024) {
        return res.status(400).json({ error: "Image size: up to 3MB" });
      }
      validatedImage = rawImage;
    }

    // ── Content moderation — checked BEFORE quota is consumed and BEFORE
    // anything touches Shelby, so a rejected post doesn't cost the user a
    // daily quota slot and never gets persisted anywhere.
    const modText = `${title.trim()}\n${(description ?? "").trim()}`;
    const modResult = await moderateContent(modText, validatedImage);
    if (modResult.flagged) {
      return res.status(422).json({
        error: "Content violates community guidelines, please revise the title/description/image.",
        categories: modResult.categories,
      });
    }

    const walletForQuota = author ?? process.env.VITE_SHELBY_ACCOUNT_ADDRESS!;
    const quotaError = await checkAndConsumeStoryQuota(walletForQuota);
    if (quotaError) return res.status(403).json({ error: quotaError });

    const id       = randomId();
    const blobName = "geostory_post_" + id.slice(0, 8) + "_" + Date.now();

    const tierSub = await getSub(walletForQuota);

    const post = {
      id,
      title:       title.trim(),
      description: (description ?? "").trim(),
      lat:         +lat,
      lng:         +lng,
      mood:        mood     ?? "😊",
      category:    category ?? "photo",
      imageBase64: validatedImage,
      author:      author ?? process.env.VITE_SHELBY_ACCOUNT_ADDRESS,
      time:        Date.now(),
      tier:        effectiveTier(tierSub), // snapshot at publish time — used to render badge
    };

    await shelbyUpload(blobName, post);
    invalidateStoriesCache();

    res.json({
      success:  true,
      id,
      blobName,
      imageUrl: validatedImage,
    });

  } catch (err) {
    console.error("[POST /api/stories]", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── GET /api/stories ────────────────────────────────────────────────────────

app.get("/api/stories", async (req, res) => {
  const address = process.env.VITE_SHELBY_ACCOUNT_ADDRESS!;

  const cached = getCachedStories();
  if (cached) {
    res.set("X-Cache", "HIT");
    const stories = await withLiveStoryTiers(cached as any[]);
    return res.json({ stories });
  }

  try {
    const account = AccountAddress.fromString(address);
    const blobs   = await shelbyClient.coordination.getAccountBlobs({ account });

    const posts = blobs
      .filter(b => b.blobNameSuffix.startsWith("geostory_post_"))
      .sort((a, b) => {
        const parts = (s: string) => s.split("_");
        const tsA = Number(parts(a.blobNameSuffix).at(-1));
        const tsB = Number(parts(b.blobNameSuffix).at(-1));
        return tsB - tsA;
      });

    const CONCURRENCY = 8;
    const stories: unknown[] = [];

    for (let i = 0; i < posts.length; i += CONCURRENCY) {
      const batch   = posts.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(p => shelbyFetchJSON(p.blobNameSuffix))
      );
      for (const r of results) {
        if (r.status === "fulfilled" && r.value) {
          stories.push(r.value);
        }
      }
    }

    setCachedStories(stories);
    res.set("X-Cache", "MISS");
    const liveStories = await withLiveStoryTiers(stories as any[]);
    res.json({ stories: liveStories });

  } catch (err) {
    console.error("[GET /api/stories]", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── GET /api/stories/feed ───────────────────────────────────────────────────

app.get("/api/stories/feed", async (_req, res) => {
  const address = process.env.VITE_SHELBY_ACCOUNT_ADDRESS!;

  try {
    const account = AccountAddress.fromString(address);
    const blobs   = await shelbyClient.coordination.getAccountBlobs({ account });

    const posts = blobs
      .filter(b => b.blobNameSuffix.startsWith("geostory_post_"))
      .sort((a, b) => {
        const tsA = Number(a.blobNameSuffix.split("_").at(-1));
        const tsB = Number(b.blobNameSuffix.split("_").at(-1));
        return tsB - tsA;
      })
      .map(b => b.blobNameSuffix);

    res.json({ posts });

  } catch (err) {
    console.error("[GET /api/stories/feed]", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── LIKES ───────────────────────────────────────────────────────────────────

const likesCache = new Map<string, string[]>();

async function getLikes(storyId: string): Promise<string[]> {
  if (likesCache.has(storyId)) return [...likesCache.get(storyId)!];

  const data = await shelbyFetchVersioned<{ likedBy: string[] }>(
    "geostory_likes_" + storyId,
    5000
  );
  const likedBy = Array.isArray(data?.likedBy) ? data!.likedBy : [];
  likesCache.set(storyId, likedBy);
  return [...likedBy];
}

async function persistLikes(storyId: string, likedBy: string[]): Promise<void> {
  await shelbyUploadVersioned("geostory_likes_" + storyId, {
    storyId,
    likedBy,
    updatedAt: Date.now(),
  });
}

app.post("/api/stories/:id/like", async (req, res) => {
  try {
    const storyId    = req.params.id;
    const { wallet } = req.body as { wallet?: string };

    if (!wallet) return res.status(400).json({ error: "Missing wallet" });

    const likedBy = await getLikes(storyId);
    const idx     = likedBy.findIndex(w => w.toLowerCase() === wallet.toLowerCase());
    const action  = idx !== -1 ? "unliked" : "liked";

    if (idx !== -1) likedBy.splice(idx, 1);
    else            likedBy.push(wallet);

    likesCache.set(storyId, [...likedBy]);

    try {
      await persistLikes(storyId, likedBy);
    } catch (persistErr: unknown) {
      // Rollback in-memory cache so it doesn't drift from what's actually on Shelby.
      console.error("[likes] persist failed:", persistErr);
      if (idx !== -1) likedBy.push(wallet);
      else            likedBy.splice(likedBy.indexOf(wallet), 1);
      likesCache.set(storyId, [...likedBy]);
      return res.status(502).json({ error: "Could not save like to Shelby, please retry" });
    }

    res.json({ success: true, action, count: likedBy.length, likedBy });

  } catch (err) {
    console.error("[POST /api/stories/:id/like]", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/stories/:id/likes", async (req, res) => {
  try {
    const likedBy = await getLikes(req.params.id);
    res.json({ likedBy, count: likedBy.length });
  } catch (err) {
    console.error("[GET /api/stories/:id/likes]", err);
    res.json({ likedBy: [], count: 0 });
  }
});

// ─── GET /api/blob/:blobName ─────────────────────────────────────────────────

app.get("/api/blob/:blobName", async (req, res) => {
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);

    const r = await fetch(SHELBY_BASE + req.params.blobName, {
      signal:  ctrl.signal,
      headers: { Authorization: "Bearer " + process.env.VITE_SHELBY_API_KEY },
    });
    clearTimeout(timer);

    if (!r.ok) return res.status(r.status).json({ error: "Blob not found" });

    const buffer  = await r.arrayBuffer();
    const isImage = req.params.blobName.startsWith("geostory_img_");
    res.set("Content-Type", isImage ? "image/jpeg" : "application/json");
    res.set("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(buffer));

  } catch (err) {
    console.error("[GET /api/blob]", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── COMMENTS ────────────────────────────────────────────────────────────────

const commentsCache = new Map<string, any[]>();

async function getComments(storyId: string): Promise<any[]> {
  if (commentsCache.has(storyId)) return [...commentsCache.get(storyId)!];
  const data = await shelbyFetchVersioned<{ comments: any[] }>(
    "geostory_comments_" + storyId, 5000
  );
  const comments = Array.isArray(data?.comments) ? data!.comments : [];
  commentsCache.set(storyId, comments);
  return [...comments];
}

async function persistComments(storyId: string, comments: any[]): Promise<void> {
  await shelbyUploadVersioned("geostory_comments_" + storyId, {
    storyId, comments, updatedAt: Date.now(),
  });
}

app.get("/api/stories/:id/comments", async (req, res) => {
  try {
    const comments = await getComments(req.params.id);
    const liveComments = await withLiveCommentTiers(comments);
    res.json({ comments: liveComments, count: liveComments.length });
  } catch (err) {
    console.error("[GET /api/stories/:id/comments]", err);
    res.json({ comments: [], count: 0 });
  }
});

app.post("/api/stories/:id/comments", async (req, res) => {
  try {
    const storyId = req.params.id;
    const { wallet, text } = req.body as { wallet?: string; text?: string };

    if (!wallet) return res.status(400).json({ error: "Missing wallet" });
    if (!text?.trim()) return res.status(400).json({ error: "Comment content is missing." });
    if (text.trim().length > 280) return res.status(400).json({ error: "Comments can be up to 280 characters." });

    const comments = await getComments(storyId);
    const tierSub  = await getSub(wallet);
    const comment = {
      id:     crypto.randomUUID().replaceAll("-", "").slice(0, 12),
      wallet,
      text:   text.trim(),
      time:   Date.now(),
      tier:   effectiveTier(tierSub), // snapshot at comment time — used to render badge
    };
    comments.push(comment);
    commentsCache.set(storyId, [...comments]);

    try {
      await persistComments(storyId, comments);
    } catch (persistErr: unknown) {
      // Rollback in-memory cache so it doesn't drift from what's actually on Shelby.
      console.error("[comments] persist failed:", persistErr);
      comments.pop();
      commentsCache.set(storyId, [...comments]);
      return res.status(502).json({ error: "Could not save comment to Shelby, please retry" });
    }

    res.json({ success: true, comment, count: comments.length });
  } catch (err) {
    console.error("[POST /api/stories/:id/comments]", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── AI TRAVEL COMPANION ─────────────────────────────────────────────────────

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

app.post("/api/ai/companion", async (req, res) => {
  try {
    const {
      message,
      history = [],
      context,
      wallet,
    } = req.body as {
      message:  string;
      history?: { role: "user" | "model"; text: string }[];
      context?: {
        placeName?: string;
        lat?:       number;
        lng?:       number;
        nearby?:    { title: string; desc: string; mood: string; cat: string; author: string }[];
        nearbyRadiusKm?: number;
        time?:      string;
        weather?:   string;
      };
      wallet?: string;
    };

    if (!message?.trim())
      return res.status(400).json({ error: "Missing message" });

    if (!wallet)
      return res.status(400).json({ error: "Missing wallet" });

    const quotaError = await checkAndConsumeAiQuota(wallet);
    if (quotaError) return res.status(403).json({ error: quotaError, upgradeRequired: true });

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey)
      return res.status(500).json({ error: "GROQ_API_KEY has not been configured." });

    // ── Build context strings ──
    const place   = context?.placeName ?? "area being viewed";
    const coords  = (context?.lat != null && context?.lng != null)
      ? `(${context.lat.toFixed(3)}, ${context.lng.toFixed(3)})`
      : "";
    const timeStr = context?.time ?? new Date().toLocaleString("vi-VN");
    const weather = context?.weather ? `Weather: ${context.weather}.` : "";

    const nearbyList = context?.nearby ?? [];
    const radiusKm   = context?.nearbyRadiusKm;

    // ── Build nearby block ──
    const nearbyBlock = nearbyList.length > 0
      ? `Community stories within ${radiusKm ?? "a short distance"}km of this exact spot (${nearbyList.length} stories found on GeoStory):\n` +
        nearbyList
          .slice(0, 5)
          .map((s, i) => `${i + 1}. "${s.title}" [${s.cat} ${s.mood}] by ${s.author}: ${s.desc.slice(0, 100)}`)
          .join("\n")
      : `NO community stories exist within ${radiusKm ?? "a short distance"}km of this area yet on GeoStory.`;

    const systemPrompt = `You are an AI Travel Companion for GeoStory — a Web3 community story map.
The user is currently viewing: ${place} ${coords}.
Time: ${timeStr}. ${weather}

${nearbyBlock}

Rules:
- Detect the language the user writes in and always reply in that same language.
- Keep answers short (2-4 sentences), friendly, and expressive.
- ONLY mention stories if they appear in the numbered list above. If the list says "NO community stories", NEVER say "according to a recent story" or imply stories exist. Instead, encourage the user to be the first to post one here.
- These stories are all within a tight radius of exactly where the user is looking — never describe them as being in a different city/district/province than the one being discussed, and never generalize them as being from "the region" or "nearby areas" more broadly than that.
- Never fabricate story titles, authors, or locations.
- Never use markdown or bullet points.`;

    // ── Call Groq ──
    const groqRes = await fetch(GROQ_URL, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model:       "llama-3.3-70b-versatile",
        max_tokens:  300,
        temperature: 0.8,
        messages: [
          { role: "system", content: systemPrompt },
          ...history.map(m => ({
            role:    m.role === "model" ? "assistant" : "user",
            content: m.text,
          })),
          { role: "user", content: message.trim() },
        ],
      }),
    });

    const groqData = await groqRes.json() as any;

    if (!groqRes.ok) {
      console.error("[AI companion] Groq error:", groqData);
      return res.status(502).json({
        error: "Groq API error: " + (groqData?.error?.message ?? groqRes.status),
      });
    }

    const reply = groqData.choices?.[0]?.message?.content ?? "";
    if (!reply)
      return res.status(502).json({ error: "No response from AI" });

    res.json({ reply });

  } catch (err) {
    console.error("[POST /api/ai/companion]", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Geocode proxy (avoids CORS with Nominatim from the browser) ─────────────

const NOMINATIM_HEADERS = {
  "User-Agent": "GeoStory/1.0 (geostory-app; contact@geostory.app)",
  "Accept-Language": "vi,en",
};

const geocodeCache = new Map<string, any>();
const geocodeSearchCache = new Map<string, any>();

app.get("/api/geocode/reverse", async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: "Missing lat/lon" });

  const key = `${Number(lat).toFixed(2)},${Number(lon).toFixed(2)}`;
  if (geocodeCache.has(key)) {
    res.set("X-Cache", "HIT");
    return res.json(geocodeCache.get(key));
  }

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&accept-language=vi,en`;
    const r = await fetch(url, { headers: NOMINATIM_HEADERS });
    if (!r.ok) return res.status(r.status).json({ error: "Nominatim error" });
    const data = await r.json();
    geocodeCache.set(key, data);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Geocode failed" });
  }
});

app.get("/api/geocode/search", async (req, res) => {
  const { q, limit = "6" } = req.query;
  if (!q) return res.status(400).json({ error: "Missing q" });

  const key = `${String(q).toLowerCase().trim()}:${limit}`;
  if (geocodeSearchCache.has(key)) {
    res.set("X-Cache", "HIT");
    return res.json(geocodeSearchCache.get(key));
  }

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(String(q))}&limit=${limit}&addressdetails=1`;
    const r = await fetch(url, { headers: NOMINATIM_HEADERS });
    if (!r.ok) return res.status(r.status).json({ error: "Nominatim error" });
    const data = await r.json();
    geocodeSearchCache.set(key, data);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Geocode search failed" });
  }
});

// ─── SUBSCRIPTIONS (Free / Pro / Premium) ───────────────────────────────────
// Payment is verified on-chain: user sends APT (testnet) to TREASURY_ADDRESS,
// we re-check that transaction on the Aptos fullnode ourselves before
// activating anything — never trust tier/txHash claims coming from the client.

interface Subscription {
  wallet:     string;
  tier:       TierName;
  expiresAt:  number;   // ms epoch; ignored when tier === "free"
  showAds:    boolean;  // premium-only toggle, default true
  txHash:     string | null;
  aiUsage:    { day: string; count: number };  // day = YYYY-MM-DD (UTC)
  storyUsage: { day: string; count: number };
}

const subsCache = new Map<string, Subscription>();
const usedTxHashesCache = new Set<string>();
let _usedTxHashesLoaded = false;

function freshSub(wallet: string): Subscription {
  return {
    wallet, tier: "free", expiresAt: 0, showAds: true, txHash: null,
    aiUsage: { day: "", count: 0 }, storyUsage: { day: "", count: 0 },
  };
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

async function getSub(wallet: string): Promise<Subscription> {
  const key = wallet.toLowerCase();
  if (subsCache.has(key)) return { ...subsCache.get(key)! };

  const data = await shelbyFetchVersioned<Subscription>("geostory_sub_" + key, 5000);
  const sub  = data && data.wallet ? data : freshSub(wallet);
  subsCache.set(key, sub);
  return { ...sub };
}

async function persistSub(sub: Subscription): Promise<void> {
  await shelbyUploadVersioned("geostory_sub_" + sub.wallet.toLowerCase(), sub);
}

async function loadUsedTxHashes(): Promise<void> {
  if (_usedTxHashesLoaded) return;
  const data = await shelbyFetchVersioned<{ hashes: string[] }>("geostory_used_tx_hashes", 5000);
  (data?.hashes ?? []).forEach(h => usedTxHashesCache.add(h));
  _usedTxHashesLoaded = true;
}

async function markTxHashUsed(hash: string): Promise<void> {
  usedTxHashesCache.add(hash);
  await shelbyUploadVersioned("geostory_used_tx_hashes", { hashes: [...usedTxHashesCache] });
}

// Returns the *effective* tier — auto-downgrades to free once expiresAt has passed.
function effectiveTier(sub: Subscription): TierName {
  if (sub.tier === "free") return "free";
  return sub.expiresAt > Date.now() ? sub.tier : "free";
}

// ─── Live tier badge enrichment ──────────────────────────────────────────────
// Stories/comments store a `tier` snapshot taken at publish time (see
// POST /api/stories and POST /api/stories/:id/comments) — that snapshot is
// kept for historical/audit purposes, but it must NOT be what decides whether
// the ⭐/👑 badge shows. The badge should reflect whether the AUTHOR currently
// holds an active (non-expired) Pro/Premium subscription — including on
// stories/comments they posted before ever subscribing. So on every read we
// overwrite `tier` with the author's *live* effectiveTier() looked up by
// wallet address. getSub() is in-memory cached, so this is cheap.
async function liveTierByWallet(wallets: string[]): Promise<Map<string, TierName>> {
  const unique = [...new Set(wallets.map(w => (w || "").toLowerCase()).filter(Boolean))];
  const result = new Map<string, TierName>();
  await Promise.all(unique.map(async addr => {
    try {
      const sub = await getSub(addr);
      result.set(addr, effectiveTier(sub));
    } catch {
      // If the lookup fails, leave it unset so callers fall back to the
      // stored snapshot rather than silently hiding a badge that should show.
    }
  }));
  return result;
}

async function withLiveStoryTiers(stories: any[]): Promise<any[]> {
  const tierByWallet = await liveTierByWallet(stories.map((s: any) => s.author));
  return stories.map((s: any) => ({
    ...s,
    tier: tierByWallet.get((s.author || "").toLowerCase()) ?? s.tier ?? "free",
  }));
}

async function withLiveCommentTiers(comments: any[]): Promise<any[]> {
  const tierByWallet = await liveTierByWallet(comments.map((c: any) => c.wallet));
  return comments.map((c: any) => ({
    ...c,
    tier: tierByWallet.get((c.wallet || "").toLowerCase()) ?? c.tier ?? "free",
  }));
}

app.get("/api/subscribe/:wallet", async (req, res) => {
  try {
    const sub = await getSub(req.params.wallet);
    res.json({
      tier:      effectiveTier(sub),
      expiresAt: sub.tier === "free" ? null : sub.expiresAt,
      showAds:   sub.showAds,
    });
  } catch (err) {
    console.error("[GET /api/subscribe/:wallet]", err);
    res.json({ tier: "free", expiresAt: null, showAds: true });
  }
});

// Verifies an on-chain APT transfer to TREASURY_ADDRESS. Never trust the
// client's claim of amount — re-derive everything from the transaction
// record itself. Returns { ok: true, paidOctas } or { ok: false, error }.
//
// Quan trọng: chủ động CHỜ giao dịch được xác nhận (confirmed) trên Aptos
// trước khi kết luận thành/bại, thay vì chỉ đọc trạng thái tức thời — vì
// ngay sau khi ví submit, tx thường còn ở trạng thái "pending" và
// getTransactionByHash lúc đó có thể chưa có field `success`, dẫn tới việc
// từ chối oan một giao dịch thực ra sẽ thành công vài giây sau. Dữ liệu chỉ
// được đẩy lên Shelby SAU KHI hàm này trả về ok: true, tức là sau khi tx đã
// thực sự confirm thành công trên chain.
async function verifyAptPayment(
  wallet: string, txHash: string, requiredOctas: number
): Promise<{ ok: true; paidOctas: number } | { ok: false; error: string; status: number }> {
  await loadUsedTxHashes();
  if (usedTxHashesCache.has(txHash))
    return { ok: false, status: 409, error: "This transaction was already used" };

  let txn: any;
  try {
    // Chờ tx được đưa vào block (confirm) trên Aptos, tối đa 30s — thay vì
    // đọc trạng thái ngay lập tức khi có thể vẫn đang pending.
    txn = await aptos.waitForTransaction({
      transactionHash: txHash,
      options: { timeoutSecs: 30, checkSuccess: false },
    });
  } catch (err) {
    console.error("[verifyAptPayment] waitForTransaction failed:", err);
    return { ok: false, status: 400, error: "Transaction not found or not confirmed on-chain within timeout" };
  }

  if (!txn || txn.success !== true)
    return { ok: false, status: 400, error: "Transaction failed or not confirmed yet" };

  const sender = (txn.sender ?? "").toLowerCase();
  if (sender !== wallet.toLowerCase())
    return { ok: false, status: 400, error: "Transaction sender does not match wallet" };

  // ── Xác định số APT đã chuyển ──────────────────────────────────────────
  // Ưu tiên đọc trực tiếp từ PAYLOAD của giao dịch — vì client của chúng ta
  // luôn gọi cố định hàm `0x1::aptos_account::transfer` với arguments
  // [recipient, amountOctas] (xem payWithAPT/submitAd trong main.ts) — cách
  // này chính xác 100%, không phụ thuộc việc ví dùng coin-store cũ hay
  // fungible-asset-store mới bên dưới (đây là nguồn gốc bug "paidOctas = 0"
  // gặp phải khi chỉ dựa vào việc so khớp địa chỉ trong events).
  let paidOctas = 0;

  const payload: any = txn.payload ?? {};
  const fnName: string =
    payload.function ?? payload.entry_function_id_str ?? "";
  const fnArgs: any[] = Array.isArray(payload.arguments) ? payload.arguments : [];

  const isKnownTransferFn =
    fnName === "0x1::aptos_account::transfer" ||
    fnName === "0x1::aptos_account::transfer_coins" ||
    fnName === "0x1::coin::transfer" ||
    fnName === "0x1::primary_fungible_store::transfer";

  if (isKnownTransferFn && fnArgs.length >= 2) {
    const recipientArg = String(fnArgs[0] ?? "").toLowerCase();
    const amountArg     = Number(fnArgs[fnArgs.length - 1]);
    if (recipientArg === TREASURY_ADDRESS.toLowerCase() && Number.isFinite(amountArg)) {
      paidOctas = amountArg;
    }
  }

  // Fallback: nếu payload không khớp mẫu trên (ví khác, script tự build...),
  // quét lại events. Không yêu cầu khớp địa chỉ store cho event FA (vì đó là
  // địa chỉ object suy ra, không phải địa chỉ ví), mà cộng dồn mọi khoản
  // deposit trong tx — an toàn vì sender đã được xác minh khớp wallet và
  // đây là giao dịch đơn (single entry-function call) do client tạo ra.
  if (paidOctas <= 0) {
    const events: any[] = Array.isArray(txn.events) ? txn.events : [];
    for (const ev of events) {
      if (ev.type === "0x1::coin::DepositEvent") {
        const owner = ev.guid?.account_address;
        if (owner && owner.toLowerCase() !== TREASURY_ADDRESS.toLowerCase()) continue;
        paidOctas += Number(ev.data?.amount ?? 0);
      } else if (ev.type === "0x1::fungible_asset::Deposit") {
        paidOctas += Number(ev.data?.amount ?? 0);
      }
    }
  }

  if (paidOctas < requiredOctas) {
    return {
      ok: false, status: 400,
      error: `Payment amount insufficient — sent ${paidOctas / OCTAS_PER_APT} APT, need ${requiredOctas / OCTAS_PER_APT} APT`,
    };
  }

  return { ok: true, paidOctas };
}

app.post("/api/subscribe", async (req, res) => {
  try {
    const { wallet, tier, txHash } = req.body as {
      wallet?: string; tier?: string; txHash?: string;
    };

    if (!wallet) return res.status(400).json({ error: "Missing wallet" });
    if (tier !== "pro" && tier !== "premium")
      return res.status(400).json({ error: "Invalid tier" });
    if (!txHash) return res.status(400).json({ error: "Missing txHash" });

    const result = await withTxHashLock(txHash, async () => {
      const requiredOctas = PRICING[tier].apt * OCTAS_PER_APT;
      const verify = await verifyAptPayment(wallet, txHash, requiredOctas);
      if (!verify.ok) return { status: verify.status, body: { error: verify.error } };

      // ── All checks passed — activate the plan ──
      const sub = await getSub(wallet);
      const now = Date.now();
      sub.tier      = tier;
      sub.expiresAt = now + PRICING[tier].days * 24 * 60 * 60 * 1000;
      sub.txHash    = txHash;

      try {
        await withRetry(() => persistSub(sub));
        await withRetry(() => markTxHashUsed(txHash));
      } catch (persistErr) {
        console.error("[subscribe] persist failed after retries:", persistErr);
        // Thanh toán đã xác minh on-chain — KHÔNG được để mất dữ liệu.
        // Đưa vào hàng đợi để tự động thử lại lưu Shelby, đồng thời vẫn kích
        // hoạt gói ngay cho người dùng (đã trả tiền thật) và trả success luôn.
        enqueuePendingWrite({ blobName: "geostory_sub_" + sub.wallet.toLowerCase(), payload: sub, txHash, kind: "subscribe" });
        subsCache.set(wallet.toLowerCase(), sub);
        return {
          status: 200,
          body: {
            success: true, tier: sub.tier, expiresAt: sub.expiresAt,
            warning: "Đã kích hoạt gói, hệ thống đang lưu lại dữ liệu trên Shelby (sẽ tự hoàn tất trong ít phút)",
          },
        };
      }

      subsCache.set(wallet.toLowerCase(), sub);
      return { status: 200, body: { success: true, tier: sub.tier, expiresAt: sub.expiresAt } };
    });

    if ("locked" in result) {
      return res.status(409).json({ error: "Giao dịch này đang được xử lý, vui lòng đợi vài giây rồi kiểm tra lại" });
    }
    res.status(result.status).json(result.body);

  } catch (err) {
    console.error("[POST /api/subscribe]", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Premium-only: toggle whether sponsored/ad content is shown to this wallet.
app.patch("/api/settings/ads", async (req, res) => {
  try {
    const { wallet, showAds } = req.body as { wallet?: string; showAds?: boolean };
    if (!wallet) return res.status(400).json({ error: "Missing wallet" });
    if (typeof showAds !== "boolean") return res.status(400).json({ error: "showAds must be boolean" });

    const sub = await getSub(wallet);
    if (effectiveTier(sub) !== "premium")
      return res.status(403).json({ error: "Only Premium can control ad visibility" });

    sub.showAds = showAds;
    try {
      await persistSub(sub);
    } catch (persistErr) {
      console.error("[settings/ads] persist failed:", persistErr);
      return res.status(502).json({ error: "Could not save setting, please retry" });
    }
    subsCache.set(wallet.toLowerCase(), sub);
    res.json({ success: true, showAds: sub.showAds });
  } catch (err) {
    console.error("[PATCH /api/settings/ads]", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Gate helpers, used by story creation + AI companion above ──

// Returns null if allowed, or an error message if the wallet is out of quota.
async function checkAndConsumeStoryQuota(wallet: string): Promise<string | null> {
  const sub  = await getSub(wallet);
  const tier = effectiveTier(sub);
  if (tier !== "free") return null; // Pro/Premium: unlimited

  const today = todayUTC();
  if (sub.storyUsage.day !== today) sub.storyUsage = { day: today, count: 0 };
  if (sub.storyUsage.count >= FREE_STORIES_PER_DAY) {
    return `Free plan is limited to ${FREE_STORIES_PER_DAY} stories/day. Upgrade to Pro for unlimited stories.`;
  }
  sub.storyUsage.count++;
  subsCache.set(wallet.toLowerCase(), sub);
  persistSub(sub).catch(err => console.error("[quota] story usage persist failed:", err));
  return null;
}

// Returns null if allowed, or an error message if the wallet is out of AI credits.
async function checkAndConsumeAiQuota(wallet: string): Promise<string | null> {
  const sub  = await getSub(wallet);
  const tier = effectiveTier(sub);
  if (tier === "free")
    return "AI companion is a Pro/Premium feature. Upgrade to unlock it.";

  const limit = PRICING[tier].aiCreditsPerDay;
  if (limit === null) return null; // Premium: unlimited

  const today = todayUTC();
  if (sub.aiUsage.day !== today) sub.aiUsage = { day: today, count: 0 };
  if (sub.aiUsage.count >= limit) {
    return `Pro plan is limited to ${limit} AI messages/day. Upgrade to Premium for unlimited AI.`;
  }
  sub.aiUsage.count++;
  subsCache.set(wallet.toLowerCase(), sub);
  persistSub(sub).catch(err => console.error("[quota] AI usage persist failed:", err));
  return null;
}

// ─── ADVERTISER CAMPAIGNS (Sponsored Pin / Feed) ────────────────────────────
// Same trust model as subscriptions: payment is verified on-chain before a
// campaign is ever activated. Content goes through the same OpenAI
// Moderation check used for regular stories before it can go live.

interface AdCampaign {
  id:          string;
  wallet:      string;
  title:       string;
  description: string;
  imageBase64?: string;
  lat:         number;
  lng:         number;
  placement:   "map" | "feed" | "combo";
  radiusKm:    number; // reach radius for feed visibility (ignored for pure "map" placement)
  days:        number;
  startAt:     number;
  endAt:       number;
  txHash:      string;
}

const adsCache = new Map<string, AdCampaign>();
let _adsIndexLoaded = false;
const adsIndex = new Set<string>(); // campaign ids, persisted so we can list them after a restart

async function loadAdsIndex(): Promise<void> {
  if (_adsIndexLoaded) return;
  const data = await shelbyFetchVersioned<{ ids: string[] }>("geostory_ads_index", 5000);
  (data?.ids ?? []).forEach(id => adsIndex.add(id));
  _adsIndexLoaded = true;
}

async function persistAdsIndex(): Promise<void> {
  await shelbyUploadVersioned("geostory_ads_index", { ids: [...adsIndex] });
}

async function getAdCampaign(id: string): Promise<AdCampaign | null> {
  if (adsCache.has(id)) return adsCache.get(id)!;
  const data = await shelbyFetchJSON<AdCampaign>("geostory_ad_" + id, 5000);
  if (data) adsCache.set(id, data);
  return data;
}

async function persistAdCampaign(ad: AdCampaign): Promise<void> {
  await shelbyUpload("geostory_ad_" + ad.id, ad);
}

function adPriceOctas(placement: "map" | "feed" | "combo", days: number, radiusKm?: number): number {
  const perDay = placement === "map" ? AD_PRICING.mapPin.aptPerDay
               : placement === "feed" ? AD_PRICING.feedPin.aptPerDay
               : AD_PRICING.combo.aptPerDay;
  // Radius only affects reach in the feed, so the multiplier only applies
  // when the campaign actually has a feed component ("feed" or "combo").
  const mult = (placement === "feed" || placement === "combo")
    ? radiusMultiplier(radiusKm ?? DEFAULT_AD_RADIUS_KM)
    : 1;
  return Math.round(perDay * mult * days * OCTAS_PER_APT);
}

// ── Pre-payment moderation check ────────────────────────────────────────────
// The wallet signs & submits the APT transfer BEFORE this server ever sees the
// campaign (that's how the client flow works), so without a pre-check an
// advertiser could pay first and only then discover their content was
// rejected — with no way to get that APT back. This endpoint lets the client
// run the same AI moderation check up front, before ever prompting the wallet
// to sign anything.
app.post("/api/ads/moderate", async (req, res) => {
  try {
    const { title, description, imageBase64 } = req.body as {
      title?: string; description?: string; imageBase64?: string;
    };
    if (!title?.trim()) return res.status(400).json({ error: "Missing or empty title" });

    const modText   = `${title.trim()}\n${(description ?? "").trim()}`;
    const modResult = await moderateContent(modText, imageBase64);
    if (modResult.flagged) {
      return res.status(422).json({
        error: "Content violates community guidelines, please revise the title/description/image.",
        categories: modResult.categories,
      });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("[POST /api/ads/moderate]", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/ads", async (req, res) => {
  try {
    const {
      wallet, title, description, imageBase64, lat, lng, placement, radiusKm: rawRadiusKm, days, txHash,
    } = req.body as {
      wallet?: string; title?: string; description?: string; imageBase64?: string;
      lat?: number; lng?: number;
      placement?: string; radiusKm?: number; days?: number; txHash?: string;
    };

    if (!wallet) return res.status(400).json({ error: "Missing wallet" });
    if (!title?.trim()) return res.status(400).json({ error: "Missing or empty title" });
    if (lat == null || lng == null) return res.status(400).json({ error: "Missing location on the map" });
    if (placement !== "map" && placement !== "feed" && placement !== "combo")
      return res.status(400).json({ error: "Invalid placement" });
    if (!days || days <= 0 || !Number.isFinite(days))
      return res.status(400).json({ error: "Invalid number of days" });
    if (!txHash) return res.status(400).json({ error: "Missing txHash" });

    // Radius only matters for feed-visible campaigns; clamp to a sane range
    // regardless so a bad/missing value can't be used to under-pay.
    const radiusKm = (placement === "feed" || placement === "combo")
      ? Math.min(300, Math.max(1, Number(rawRadiusKm) || DEFAULT_AD_RADIUS_KM))
      : 0;

    // ── Content moderation — checked BEFORE payment verification, so a
    // rejected campaign never even asks the advertiser to pay. (The client
    // also runs /api/ads/moderate before requesting a wallet signature at
    // all; this is the authoritative second check server-side.)
    const modText   = `${title.trim()}\n${(description ?? "").trim()}`;
    const modResult = await moderateContent(modText, imageBase64);
    if (modResult.flagged) {
      return res.status(422).json({
        error: "Content violates community guidelines, please revise the title/description/image.",
        categories: modResult.categories,
      });
    }

    // ── Verify payment on-chain (bọc trong lock để chống double-submit) ──
    const result = await withTxHashLock(txHash, async () => {
      const requiredOctas = adPriceOctas(placement, days, radiusKm);
      const verify = await verifyAptPayment(wallet, txHash, requiredOctas);
      if (!verify.ok) return { status: verify.status, body: { error: verify.error } };

      const now = Date.now();
      const ad: AdCampaign = {
        id:          crypto.randomUUID().replaceAll("-", "").slice(0, 12),
        wallet,
        title:       title.trim(),
        description: (description ?? "").trim(),
        imageBase64,
        lat:         +lat,
        lng:         +lng,
        placement:   placement as "map" | "feed" | "combo",
        radiusKm,
        days,
        startAt:     now,
        endAt:       now + days * 24 * 60 * 60 * 1000,
        txHash,
      };

      try {
        await loadAdsIndex();
        await withRetry(() => persistAdCampaign(ad));
        adsIndex.add(ad.id);
        await withRetry(() => persistAdsIndex());
        await withRetry(() => markTxHashUsed(txHash));
      } catch (persistErr) {
        console.error("[ads] persist failed after retries:", persistErr);
        // Thanh toán đã xác minh on-chain — vẫn kích hoạt campaign ngay,
        // đưa việc lưu Shelby vào hàng đợi để tự động hoàn tất sau.
        enqueuePendingWrite({ blobName: "geostory_ad_" + ad.id, payload: ad, txHash, kind: "ads" });
        adsCache.set(ad.id, ad);
        return {
          status: 200,
          body: {
            success: true, campaign: ad,
            warning: "Chiến dịch đã kích hoạt, hệ thống đang lưu lại dữ liệu trên Shelby (sẽ tự hoàn tất trong ít phút)",
          },
        };
      }

      adsCache.set(ad.id, ad);
      return { status: 200, body: { success: true, campaign: ad } };
    });

    if ("locked" in result) {
      return res.status(409).json({ error: "Giao dịch này đang được xử lý, vui lòng đợi vài giây rồi kiểm tra lại" });
    }
    res.status(result.status).json(result.body);

  } catch (err) {
    console.error("[POST /api/ads]", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/ads/active", async (req, res) => {
  try {
    // Note: this endpoint always returns the full active campaign list, even
    // for Premium wallets that have opted out of ads (showAds === false).
    // Whether to actually DISPLAY ads for that wallet is a client-side
    // rendering preference (see toggleAdsVisibility() in main.ts) — keeping
    // it client-side means flipping the "hide ads" switch is instant (no
    // round trip / refetch needed) instead of feeling laggy.
    await loadAdsIndex();
    const now = Date.now();
    const campaigns: AdCampaign[] = [];
    for (const id of adsIndex) {
      const ad = await getAdCampaign(id);
      if (ad && ad.endAt > now) campaigns.push(ad);
    }
    res.json({ campaigns });
  } catch (err) {
    console.error("[GET /api/ads/active]", err);
    res.json({ campaigns: [] });
  }
});

// Advertiser's own campaigns (active + recently expired) for management UI.
app.get("/api/ads/mine/:wallet", async (req, res) => {
  try {
    const wallet = req.params.wallet.toLowerCase();
    await loadAdsIndex();
    const now = Date.now();
    const mine: AdCampaign[] = [];
    for (const id of adsIndex) {
      const ad = await getAdCampaign(id);
      if (ad && ad.wallet.toLowerCase() === wallet) mine.push(ad);
    }
    mine.sort((a, b) => b.startAt - a.startAt);
    res.json({
      campaigns: mine.map(ad => ({
        ...ad,
        active:   ad.endAt > now,
        daysLeft: Math.max(0, Math.ceil((ad.endAt - now) / (24 * 60 * 60 * 1000))),
      })),
    });
  } catch (err) {
    console.error("[GET /api/ads/mine/:wallet]", err);
    res.json({ campaigns: [] });
  }
});



// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 3001);
app.listen(PORT, () => console.log("🚀 GeoStory server running at http://localhost:" + PORT));
