import crypto from "crypto";

import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";

import {
  Account,
  AccountAddress,
  Ed25519PrivateKey,
  Network,
} from "@aptos-labs/ts-sdk";

import { ShelbyNodeClient } from "@shelby-protocol/sdk/node";

// ─── App setup ───────────────────────────────────────────────────────────────

const app = express();

app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  handler: (_req, res) => {
    res.status(429).json({ error: "Too many requests, chill bro 😅" });
  },
});
app.use("/api/stories", limiter);

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

    const id       = randomId();
    const blobName = "geostory_post_" + id.slice(0, 8) + "_" + Date.now();

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
    return res.json({ stories: cached });
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
    res.json({ stories });

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

  const data = await shelbyFetchJSON<{ likedBy: string[] }>(
    "geostory_likes_" + storyId,
    5000
  );
  const likedBy = Array.isArray(data?.likedBy) ? data!.likedBy : [];
  likesCache.set(storyId, likedBy);
  return [...likedBy];
}

async function persistLikes(storyId: string, likedBy: string[]): Promise<void> {
  await shelbyUpload("geostory_likes_" + storyId, {
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
    res.json({ success: true, action, count: likedBy.length, likedBy });

    persistLikes(storyId, likedBy).catch((err: unknown) =>
      console.error("[likes] background persist failed:", err)
    );

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
  const data = await shelbyFetchJSON<{ comments: any[] }>(
    "geostory_comments_" + storyId, 5000
  );
  const comments = Array.isArray(data?.comments) ? data!.comments : [];
  commentsCache.set(storyId, comments);
  return [...comments];
}

async function persistComments(storyId: string, comments: any[]): Promise<void> {
  await shelbyUpload("geostory_comments_" + storyId, {
    storyId, comments, updatedAt: Date.now(),
  });
}

app.get("/api/stories/:id/comments", async (req, res) => {
  try {
    const comments = await getComments(req.params.id);
    res.json({ comments, count: comments.length });
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
    const comment = {
      id:     crypto.randomUUID().replaceAll("-", "").slice(0, 12),
      wallet,
      text:   text.trim(),
      time:   Date.now(),
    };
    comments.push(comment);
    commentsCache.set(storyId, [...comments]);
    res.json({ success: true, comment, count: comments.length });

    persistComments(storyId, comments).catch((err: unknown) =>
      console.error("[comments] persist failed:", err)
    );
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
    } = req.body as {
      message:  string;
      history?: { role: "user" | "model"; text: string }[];
      context?: {
        placeName?: string;
        lat?:       number;
        lng?:       number;
        nearby?:    { title: string; desc: string; mood: string; cat: string; author: string }[];
        time?:      string;
        weather?:   string;
      };
    };

    if (!message?.trim())
      return res.status(400).json({ error: "Missing message" });

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

    // ── Build nearby block — rõ ràng có hay không ──
    const nearbyBlock = nearbyList.length > 0
      ? `Community stories near this area (${nearbyList.length} stories found on GeoStory):\n` +
        nearbyList
          .slice(0, 5)
          .map((s, i) => `${i + 1}. "${s.title}" [${s.cat} ${s.mood}] by ${s.author}: ${s.desc.slice(0, 100)}`)
          .join("\n")
      : "NO community stories exist in this area yet on GeoStory.";

    const systemPrompt = `You are an AI Travel Companion for GeoStory — a Web3 community story map.
The user is currently viewing: ${place} ${coords}.
Time: ${timeStr}. ${weather}

${nearbyBlock}

Rules:
- Detect the language the user writes in and always reply in that same language.
- Keep answers short (2-4 sentences), friendly, and expressive.
- ONLY mention stories if they appear in the numbered list above. If the list says "NO community stories", NEVER say "according to a recent story" or imply stories exist. Instead, encourage the user to be the first to post one here.
- Never fabricate story titles, authors, or locations.
- Never use markdown or bullet points.`;

    // ── Gọi Groq ──
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

// ─── Geocode proxy (tránh CORS Nominatim từ browser) ─────────────────────────

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

// ─── Start ───────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 3001);
app.listen(PORT, () => console.log("🚀 GeoStory server running at http://localhost:" + PORT));