# Shopify Labels

A Shopify embedded app for generating printable product labels with barcodes and prices. Built for [Pandora's Deck Box](https://pandorasdeckbox.com) — live at **labels.pandorasdeckbox.com**.

## What It Does

- Pulls your full product catalog from Shopify
- Search, filter, and sort products by name, barcode, vendor, or type
- Select products and set quantities to build a print queue
- Generates a PDF label sheet ready for printing on Avery label paper
- Supports barcode mode (EAN-13/UPC-A/Code128) and QR code mode (SKU)
- Configurable label profiles with fine-tuning controls
- Offset support for reusing partially-printed label sheets

## Architecture

| Component | Technology |
|-----------|-----------|
| Backend | Express.js (Node 18+) |
| Frontend | Vanilla JS single-page app |
| PDF Generation | pdf-lib + bwip-js (barcodes) + qrcode |
| Database | PostgreSQL (Railway) / SQLite (local dev) |
| Auth | Shopify OAuth (offline tokens, custom flow for iframe) |
| Hosting | Railway (labels.pandorasdeckbox.com) |

```
shopify-labels/
├── server.js            # Express server, OAuth, API routes
├── database.js          # PostgreSQL/SQLite, sessions, settings, history
├── labelGenerator.js    # PDF generation (port of sku-to-labels.py)
├── public/
│   └── index.html       # Single-page app UI
├── package.json
├── railway.json         # Railway deployment config
├── Procfile
└── .env.example
```

## Label Profiles

The default profile is **Avery 6460 (Mini Address Labels)** — custom-tuned for the store's printer. Additional profiles included:

| Profile | Size | Layout |
|---------|------|--------|
| `avery_6460` | 2.975" × 1.075" | 3 × 10 (30/sheet) — **default** |
| `avery_5160` | 2.625" × 1.0" | 3 × 10 (30/sheet) |
| `avery_5261` | 4.0" × 1.0" | 2 × 10 (20/sheet) |
| `avery_5162` | 4.0" × 1.33" | 2 × 7 (14/sheet) |

All profile dimensions and margins are adjustable via the Settings tab in the app.

## Setup

### 1. Create Shopify App

1. Go to [Shopify Partner Dashboard](https://partners.shopify.com/) → Apps → Create App
2. Choose "Custom app" (or "Create app manually" if using dev dashboard)
3. Set **App URL**: `https://labels.pandorasdeckbox.com/app`
4. Set **Allowed redirection URL**: `https://labels.pandorasdeckbox.com/auth/callback`
5. Under **API access scopes**, request: `read_products`
6. Copy the **API key** and **API secret**

### 2. Deploy to Railway

1. Push this repo to GitHub
2. Railway → New Project → Deploy from GitHub → Select `shopify-labels`
3. Add PostgreSQL database (Railway auto-injects `DATABASE_URL`)
4. Set environment variables:

| Variable | Value |
|----------|-------|
| `SHOPIFY_API_KEY` | Your Shopify app API key |
| `SHOPIFY_API_SECRET` | Your Shopify app API secret |
| `APP_URL` | `https://labels.pandorasdeckbox.com` |
| `NODE_ENV` | `production` |

5. Add custom domain: `labels.pandorasdeckbox.com`
6. Railway will auto-detect `Procfile` and run `node server.js`

### 3. Install on Store

Visit: `https://labels.pandorasdeckbox.com/auth?shop=pandorasdeckbox.myshopify.com`

Grant `read_products` permission → you're in!

### 4. DNS (Cloudflare)

Point `labels.pandorasdeckbox.com` CNAME to your Railway domain.

## Local Development

```bash
# Clone
git clone https://github.com/pandorasdeckbox/shopify-labels.git
cd shopify-labels

# Install
npm install

# Create .env from template
cp .env.example .env
# Edit .env with your Shopify API credentials

# Start cloudflare tunnel (for Shopify OAuth callback)
npm run tunnel

# Update .env APP_URL with the tunnel URL

# Run
npm run dev
```

Then visit: `http://localhost:3000/app?shop=pandorasdeckbox.myshopify.com`

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/app` | Serve app (with auth check) |
| GET | `/auth` | Start OAuth |
| GET | `/auth/callback` | OAuth callback |
| GET | `/api/shop` | Current shop info |
| GET | `/api/products` | All products (paginated) |
| GET | `/api/settings` | Get label settings |
| POST | `/api/settings` | Save label settings |
| POST | `/api/generate-labels` | Generate label PDF |
| POST | `/api/alignment-test` | Generate alignment test PDF |
| GET | `/api/history` | Print history |

## Usage

1. Open the app from Shopify admin (or direct URL)
2. **Products tab**: Search/filter your catalog, click products to add to the print queue
3. **Print Queue** (right sidebar): Adjust quantities, set offset for partially-used sheets, hit Generate PDF
4. **Settings tab**: Switch label profiles, fine-tune margins, print alignment test
5. **History tab**: View past print jobs

## Origin

This app is a web-based port of the Python `sku-to-labels.py` script, which generates label PDFs from CSV files. The Shopify app version adds:
- Direct product catalog integration (no CSV needed)
- Visual product browser with search/filter
- Interactive print queue with quantity controls
- Offset support for reusing sheets
- Settings persistence and history tracking
