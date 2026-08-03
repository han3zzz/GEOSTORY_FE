# GEOSTORY

Frontend for **GeoStory**, a map-based app for posting location-tagged stories, storing them on **Shelby Protocol**, and paying for subscriptions/ads on **Aptos**.

Live: [geostory.xyz](https://geostory.xyz)

## Stack

- Plain TypeScript + Vite (no framework — single `src/main.ts` entry, `index.html`, `style.css`)
- [Leaflet.js](https://leafletjs.com/) for the map
- Petra wallet (Aptos) for authentication and signing; a "Demo Mode" is available without a wallet
- `vite-plugin-node-polyfills` — required because the Aptos/Shelby SDKs use `Buffer` in the browser bundle

## What it does

- Renders stories as pins on a Leaflet map, with a feed sidebar, category filters (photo / adventure / food / art / travel / nature), and a heatmap toggle
- Posting a story: title, description, photo, mood, category, and a location picked directly on the map — uploaded to Shelby
- Wallet profile panel (address, story count, likes)
- Paid subscription tiers (`pro` / `premium`) and paid ad placements (map pin / feed pin / combo), settled via Aptos on-chain payments

## Backend

The app talks to a separate Express API included as server.ts at the root which holds the Shelby signing key and verifies on-chain payments. It is deployed separately, currently on Render:

```
https://geostory-0wfq.onrender.com
```

`vite.config.ts` proxies local `/api/*` requests to that URL during development.

### Endpoints called by the frontend

| Endpoint | Purpose |
|---|---|
| `GET /api/stories`, `GET/POST /api/stories/:id` | List / read / write stories |
| `POST /api/subscribe`, `GET /api/subscribe/:wallet` | Subscription purchase & status |
| `POST /api/ads`, `GET /api/ads/active`, `GET /api/ads/mine/:wallet` | Ad campaign creation & listing |
| `POST /api/ads/moderate` | Pre-payment AI content moderation for ad campaigns |
| `POST /api/ai/companion` | AI-assisted feature (rate-limited) |
| `GET /api/geocode/search`, `GET /api/geocode/reverse` | Geocoding for location search |
| `GET/POST /api/settings/ads` | Per-wallet ad display preference |

## Project structure

```
GEOSTORY_FE/
├── public/
│   └── logo_geostory.png
├── src/
│   └── main.ts        # entire app logic
├── index.html          # main entry
├── in.html             # secondary/alternate page (Vietnamese-only variant)
├── style.css
├── server.ts            # Express API (deployed separately)
├── vite.config.ts
└── package.json
```

## Setup

```bash
git clone https://github.com/han3zzz/GEOSTORY_FE.git
cd GEOSTORY_FE
npm install
npm run dev       # http://localhost:5173, proxies /api to the deployed backend
```

To run the backend locally instead of using the proxy, see `server.ts` — it requires `VITE_SHELBY_API_KEY`, `VITE_SHELBY_ACCOUNT_PRIVATE_KEY`, and `VITE_SHELBY_ACCOUNT_ADDRESS`, then:

```bash
npm run server     # http://localhost:3001
```

and point `vite.config.ts`'s proxy target at `http://localhost:3001`.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Production build |
| `npm run preview` | Preview the production build |
| `npm run server` | Run the Express API (`tsx watch server.ts`) |

## License

No license file present.
