/**
 * Shopify Labels — Embedded App Server
 *
 * Generates printable barcode/QR labels for Shopify products.
 * Products are fetched from the Shopify Admin API, users search/filter/select
 * products, then generate a PDF label sheet ready for printing.
 *
 * Authentication: Custom OAuth (bypasses iframe cookie restrictions)
 * Storage: PostgreSQL (Railway prod) / SQLite (local dev)
 * Hosting: labels.pandorasdeckbox.com via Railway
 */

import express from 'express';
import { shopifyApi, LogSeverity, ApiVersion, Session } from '@shopify/shopify-api';
import '@shopify/shopify-api/adapters/node';
import dotenv from 'dotenv';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  initDatabase,
  sessionStorage as getSessionStorage,
  getSettings,
  saveSettings,
  getDefaultSettings,
  savePrintHistory,
  getPrintHistory,
} from './database.js';

import { generateLabelPDF, generateAlignmentTestPDF } from './labelGenerator.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Startup env var check ──────────────────────────────────────────────────

const REQUIRED_ENV = ['SHOPIFY_API_KEY', 'SHOPIFY_API_SECRET', 'APP_URL'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`\n❌ Missing required environment variables: ${missing.join(', ')}`);
  console.error('   Set these in Railway → your service → Variables, then redeploy.\n');
  process.exit(1);
}

await initDatabase();

// ─── Logger ────────────────────────────────────────────────────────────────────

function log(level, msg, data = {}) {
  const ts = new Date().toISOString();
  const icons = { INFO: '📋', WARN: '⚠️ ', ERROR: '❌', SUCCESS: '✅', DEBUG: '🔍' };
  const icon = icons[level] ?? '  ';
  const dataStr = Object.keys(data).length ? ' ' + JSON.stringify(data) : '';
  console.log(`[${ts}] ${icon} [${level}] ${msg}${dataStr}`);
}

import { sessionStorage } from './database.js';

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// In-memory OAuth state (avoids cookie issues in embedded iframes)
const oauthStateStorage = new Map();

// ─── Shopify API Setup ────────────────────────────────────────────────────────

const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: ['read_products'],
  hostName: process.env.APP_URL?.replace(/https?:\/\//, '') || 'localhost',
  hostScheme: 'https',
  apiVersion: ApiVersion.January25,
  isEmbeddedApp: true,
  sessionStorage,
  logger: { level: IS_PRODUCTION ? LogSeverity.Warning : LogSeverity.Debug },
  useOnlineTokens: false,
});

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

if (IS_PRODUCTION) app.set('trust proxy', 1);

// ─── Session Verification ────────────────────────────────────────────────────

async function verifySession(req, res) {
  const shop = req.query.shop || req.body?.shop;
  if (!shop) {
    res.status(400).json({ error: 'Missing shop parameter' });
    return null;
  }

  const sanitizedShop = shopify.utils.sanitizeShop(shop, true);
  if (!sanitizedShop) {
    res.status(400).json({ error: 'Invalid shop parameter' });
    return null;
  }

  const session = await sessionStorage.loadSession(`offline_${sanitizedShop}`);
  if (!session) {
    res.status(401).json({ error: 'Not authenticated. Please reinstall the app.' });
    return null;
  }

  req.shopifySession = session;
  return session;
}

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ─── Serve App Shell ──────────────────────────────────────────────────────────

app.get('/', async (req, res) => {
  const { shop, host } = req.query;
  if (!shop) return res.status(400).send('Missing shop parameter');

  const sanitizedShop = shopify.utils.sanitizeShop(shop);
  if (!sanitizedShop) return res.status(400).send('Invalid shop parameter');

  const session = await sessionStorage.loadSession(`offline_${sanitizedShop}`);
  if (!session) {
    const authUrl = `/auth?shop=${encodeURIComponent(sanitizedShop)}${host ? `&host=${encodeURIComponent(String(host))}` : ''}`;
    return res.send(`<!DOCTYPE html><html><head><script>window.top.location.href=${JSON.stringify(authUrl)};<\/script></head><body>Redirecting...</body></html>`);
  }

  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/app', async (req, res) => {
  const { shop, host } = req.query;
  if (!shop) return res.status(400).send('Missing shop parameter');

  const sanitizedShop = shopify.utils.sanitizeShop(shop);
  if (!sanitizedShop) return res.status(400).send('Invalid shop parameter');

  const session = await sessionStorage.loadSession(`offline_${sanitizedShop}`);
  if (!session) {
    const authUrl = `/auth?shop=${encodeURIComponent(sanitizedShop)}${host ? `&host=${encodeURIComponent(String(host))}` : ''}`;
    return res.send(`<!DOCTYPE html><html><head><script>window.top.location.href=${JSON.stringify(authUrl)};<\/script></head><body>Redirecting...</body></html>`);
  }

  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Exit iFrame (needed for embedded OAuth) ──────────────────────────────────

app.get('/exitiframe', (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).send('Missing shop parameter');
  const sanitizedShop = shopify.utils.sanitizeShop(shop);
  if (!sanitizedShop) return res.status(400).send('Invalid shop parameter');
  const redirectUri = `https://${sanitizedShop}/admin/apps/${process.env.SHOPIFY_API_KEY}/auth?shop=${encodeURIComponent(sanitizedShop)}`;
  res.send(`<!DOCTYPE html><html><head><script>window.top.location.href=${JSON.stringify(redirectUri)};</script></head><body>Redirecting...</body></html>`);
});

// ─── OAuth ────────────────────────────────────────────────────────────────────

app.get('/auth', async (req, res) => {
  try {
    const shop = req.query.shop;
    if (!shop) return res.status(400).send('Missing shop parameter');

    const sanitizedShop = shopify.utils.sanitizeShop(shop, true);
    if (!sanitizedShop) return res.status(400).send('Invalid shop parameter');

    const state = crypto.randomBytes(16).toString('hex');
    oauthStateStorage.set(sanitizedShop, state);

    const authUrl = `https://${sanitizedShop}/admin/oauth/authorize?` + new URLSearchParams({
      client_id: process.env.SHOPIFY_API_KEY,
      scope: 'read_products',
      redirect_uri: `${process.env.APP_URL}/auth/callback`,
      state,
    }).toString();

    log('INFO', `OAuth started for ${sanitizedShop}`);
    res.redirect(authUrl);
  } catch (err) {
    log('ERROR', 'Auth error', { error: err.message });
    res.status(500).send('Authentication failed: ' + err.message);
  }
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { shop, code, state } = req.query;
    if (!shop || !code || !state) throw new Error('Missing required OAuth parameters');

    const sanitizedShop = shopify.utils.sanitizeShop(shop, true);
    if (!sanitizedShop) throw new Error('Invalid shop parameter');

    // Verify state (CSRF protection)
    const storedState = oauthStateStorage.get(sanitizedShop);
    if (storedState !== state) throw new Error('Invalid OAuth state parameter');
    oauthStateStorage.delete(sanitizedShop);

    // Exchange code for access token
    const tokenResponse = await fetch(`https://${sanitizedShop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        code,
      }),
    });

    if (!tokenResponse.ok) {
      const errBody = await tokenResponse.text();
      throw new Error(`Token exchange failed: ${tokenResponse.status} ${errBody}`);
    }

    const tokenData = await tokenResponse.json();
    const { access_token, scope } = tokenData;

    // Create and store session
    const session = new Session({
      id: `offline_${sanitizedShop}`,
      shop: sanitizedShop,
      state: '',
      isOnline: false,
      scope,
      accessToken: access_token,
    });

    await sessionStorage.storeSession(session);
    log('SUCCESS', `OAuth completed for ${sanitizedShop}`);

    // Redirect back into Shopify admin
    res.redirect(`https://${sanitizedShop}/admin/apps/${process.env.SHOPIFY_API_KEY}`);
  } catch (err) {
    log('ERROR', 'OAuth callback error', { error: err.message });
    res.status(500).send('Authentication failed: ' + err.message);
  }
});

// ─── API: Shop Info ──────────────────────────────────────────────────────────

app.get('/api/shop', async (req, res) => {
  try {
    const session = await verifySession(req, res);
    if (!session) return;

    const client = new shopify.clients.Rest({ session });
    const response = await client.get({ path: 'shop' });

    res.json(response.body.shop);
  } catch (err) {
    log('ERROR', 'Failed to fetch shop', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch shop info' });
  }
});

// ─── In-memory cache ─────────────────────────────────────────────────────────

const dataCache = new Map(); // shop -> { products, collections, productCollectionMap, timestamp }
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCachedData(shop, key) {
  const entry = dataCache.get(shop);
  if (!entry || !entry[key]) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    dataCache.delete(shop);
    return null;
  }
  return entry[key];
}

function setCachedData(shop, data) {
  const existing = dataCache.get(shop) || {};
  dataCache.set(shop, { ...existing, ...data, timestamp: Date.now() });
}

// ─── Shared fetch helpers ────────────────────────────────────────────────────

async function fetchAllProducts(client) {
  let allProducts = [];
  let params = { limit: 250, fields: 'id,title,variants,images,product_type,vendor,tags,status' };
  let hasMore = true;
  while (hasMore) {
    const response = await client.get({ path: 'products', query: params });
    allProducts = allProducts.concat(response.body.products || []);
    if (response.pageInfo?.nextPage) {
      params = response.pageInfo.nextPage.query;
    } else {
      hasMore = false;
    }
  }
  return allProducts;
}

async function fetchCollectionsData(client) {
  const productCollectionMap = {};

  // Custom collections
  let customCollections = [];
  let ccParams = { limit: 250 };
  let ccHasMore = true;
  while (ccHasMore) {
    const ccRes = await client.get({ path: 'custom_collections', query: ccParams });
    customCollections = customCollections.concat(ccRes.body.custom_collections || []);
    if (ccRes.pageInfo?.nextPage) {
      ccParams = ccRes.pageInfo.nextPage.query;
    } else {
      ccHasMore = false;
    }
  }

  // Smart collections
  let smartCollections = [];
  let scParams = { limit: 250 };
  let scHasMore = true;
  while (scHasMore) {
    const scRes = await client.get({ path: 'smart_collections', query: scParams });
    smartCollections = smartCollections.concat(scRes.body.smart_collections || []);
    if (scRes.pageInfo?.nextPage) {
      scParams = scRes.pageInfo.nextPage.query;
    } else {
      scHasMore = false;
    }
  }

  const collections = [...customCollections, ...smartCollections];

  // Collects (product-to-custom-collection mappings)
  let allCollects = [];
  let collectParams = { limit: 250 };
  let collectHasMore = true;
  while (collectHasMore) {
    const colRes = await client.get({ path: 'collects', query: collectParams });
    allCollects = allCollects.concat(colRes.body.collects || []);
    if (colRes.pageInfo?.nextPage) {
      collectParams = colRes.pageInfo.nextPage.query;
    } else {
      collectHasMore = false;
    }
  }

  // Build collection id -> title map
  const collectionIdToTitle = {};
  collections.forEach(c => { collectionIdToTitle[c.id] = c.title; });

  allCollects.forEach(col => {
    const title = collectionIdToTitle[col.collection_id];
    if (title) {
      if (!productCollectionMap[col.product_id]) productCollectionMap[col.product_id] = [];
      if (!productCollectionMap[col.product_id].includes(title)) {
        productCollectionMap[col.product_id].push(title);
      }
    }
  });

  // Smart collection product mapping
  for (const sc of smartCollections) {
    let scProdParams = { limit: 250, collection_id: sc.id, fields: 'id' };
    let scProdHasMore = true;
    while (scProdHasMore) {
      const spRes = await client.get({ path: 'products', query: scProdParams });
      (spRes.body.products || []).forEach(p => {
        if (!productCollectionMap[p.id]) productCollectionMap[p.id] = [];
        if (!productCollectionMap[p.id].includes(sc.title)) {
          productCollectionMap[p.id].push(sc.title);
        }
      });
      if (spRes.pageInfo?.nextPage) {
        scProdParams = spRes.pageInfo.nextPage.query;
      } else {
        scProdHasMore = false;
      }
    }
  }

  const collectionNames = [...new Set(collections.map(c => c.title))].sort();
  return { collectionNames, productCollectionMap };
}

// ─── API: Products (SSE streaming for fresh fetches, JSON for cached) ────────

app.get('/api/products', async (req, res) => {
  try {
    const session = await verifySession(req, res);
    if (!session) return;

    const forceRefresh = req.query.refresh === '1';
    const cacheOnly = req.query.cacheOnly === '1';
    const wantStream = req.headers.accept === 'text/event-stream';

    // Check cache first
    let allProducts = !forceRefresh ? getCachedData(session.shop, 'products') : null;

    // If cached, always return JSON (fast path)
    if (allProducts) {
      log('INFO', `Serving ${allProducts.length} cached products for ${session.shop}`);

      const collectionData = getCachedData(session.shop, 'collectionNames');
      const productCollectionMap = getCachedData(session.shop, 'productCollectionMap');
      if (collectionData && productCollectionMap) {
        allProducts.forEach(p => { p.collections = productCollectionMap[p.id] || []; });
      }

      return res.json({
        products: allProducts,
        collections: collectionData || [],
        collectionsLoaded: !!collectionData,
        total: allProducts.length,
      });
    }

    // Not cached — if client only wanted cache, tell it to use SSE
    if (cacheOnly) {
      return res.status(204).end();
    }

    // Not cached — stream batches via SSE if client supports it
    if (wantStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const client = new shopify.clients.Rest({ session });
      let allFetched = [];
      let params = { limit: 250, fields: 'id,title,variants,images,product_type,vendor,tags,status' };
      let hasMore = true;
      let batchNum = 0;

      while (hasMore) {
        const response = await client.get({ path: 'products', query: params });
        const products = response.body.products || [];
        allFetched = allFetched.concat(products);
        batchNum++;

        // Send this batch to the client
        res.write(`data: ${JSON.stringify({ type: 'batch', products, batchNum, totalSoFar: allFetched.length })}\n\n`);

        if (response.pageInfo?.nextPage) {
          params = response.pageInfo.nextPage.query;
        } else {
          hasMore = false;
        }
      }

      // Cache the full result
      setCachedData(session.shop, { products: allFetched });
      log('INFO', `Streamed ${allFetched.length} products in ${batchNum} batches for ${session.shop}`);

      // Send done event
      res.write(`data: ${JSON.stringify({ type: 'done', total: allFetched.length })}\n\n`);
      res.end();
    } else {
      // Fallback: non-streaming JSON fetch
      const client = new shopify.clients.Rest({ session });
      allProducts = await fetchAllProducts(client);
      setCachedData(session.shop, { products: allProducts });
      log('INFO', `Fetched ${allProducts.length} products from Shopify for ${session.shop}`);

      res.json({
        products: allProducts,
        collections: [],
        collectionsLoaded: false,
        total: allProducts.length,
      });
    }
  } catch (err) {
    log('ERROR', 'Failed to fetch products', { error: err.message });
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to fetch products' });
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
      res.end();
    }
  }
});

// ─── API: Collections (loaded separately) ────────────────────────────────────

app.get('/api/collections', async (req, res) => {
  try {
    const session = await verifySession(req, res);
    if (!session) return;

    const forceRefresh = req.query.refresh === '1';

    let collectionNames = !forceRefresh ? getCachedData(session.shop, 'collectionNames') : null;
    let productCollectionMap = !forceRefresh ? getCachedData(session.shop, 'productCollectionMap') : null;

    if (!collectionNames || !productCollectionMap) {
      const client = new shopify.clients.Rest({ session });
      const data = await fetchCollectionsData(client);
      collectionNames = data.collectionNames;
      productCollectionMap = data.productCollectionMap;
      setCachedData(session.shop, { collectionNames, productCollectionMap });
      log('INFO', `Fetched ${collectionNames.length} collections for ${session.shop}`);
    } else {
      log('INFO', `Serving cached collections for ${session.shop}`);
    }

    res.json({ collections: collectionNames, productCollectionMap });
  } catch (err) {
    log('ERROR', 'Failed to fetch collections', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch collections' });
  }
});

// ─── API: Settings ───────────────────────────────────────────────────────────

app.get('/api/settings', async (req, res) => {
  try {
    const session = await verifySession(req, res);
    if (!session) return;

    const settings = await getSettings(session.shop);
    res.json(settings);
  } catch (err) {
    log('ERROR', 'Failed to get settings', { error: err.message });
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const session = await verifySession(req, res);
    if (!session) return;

    const { settings } = req.body;
    if (!settings) return res.status(400).json({ error: 'Missing settings' });

    await saveSettings(session.shop, settings);
    log('SUCCESS', `Settings saved for ${session.shop}`);
    res.json({ success: true });
  } catch (err) {
    log('ERROR', 'Failed to save settings', { error: err.message });
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// ─── API: Generate Labels PDF ────────────────────────────────────────────────

app.post('/api/generate-labels', async (req, res) => {
  try {
    const session = await verifySession(req, res);
    if (!session) return;

    const { products, offset, mode, profile: profileName } = req.body;

    if (!products || !Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: 'No products provided' });
    }

    // Validate products
    const validProducts = products.filter(p => p && typeof p.name === 'string' && typeof p.price === 'number');
    if (validProducts.length === 0) {
      return res.status(400).json({ error: 'No valid products found' });
    }

    // Get settings for profile
    const settings = await getSettings(session.shop);
    const activeProfile = profileName || settings.active_profile || 'avery_6460';
    const profileConfig = settings.profiles?.[activeProfile] || getDefaultSettings().profiles.avery_6460;

    const labelMode = mode || settings.default_mode || 'barcode';
    const labelOffset = typeof offset === 'number' ? Math.max(0, offset) : (settings.default_offset || 0);

    log('INFO', `Generating ${validProducts.length} labels`, {
      shop: session.shop,
      mode: labelMode,
      profile: activeProfile,
      offset: labelOffset,
    });

    const pdfBuffer = await generateLabelPDF(validProducts, profileConfig, {
      mode: labelMode,
      offset: labelOffset,
      fontScale: settings.font_scale || 0.85,
      barcodeScale: settings.barcode_scale || 0.9,
    });

    // Save print history
    await savePrintHistory(session.shop, {
      label_count: validProducts.length,
      offset_used: labelOffset,
      profile_name: activeProfile,
      mode: labelMode,
      products_json: JSON.stringify(validProducts.map(p => ({ name: p.name, barcode: p.barcode, price: p.price }))),
    });

    log('SUCCESS', `Generated ${validProducts.length} labels for ${session.shop}`);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="labels-${labelMode}-${Date.now()}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    log('ERROR', 'Failed to generate labels', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Failed to generate labels: ' + err.message });
  }
});

// ─── API: Alignment Test PDF ─────────────────────────────────────────────────

app.post('/api/alignment-test', async (req, res) => {
  try {
    const session = await verifySession(req, res);
    if (!session) return;

    const { mode, profile: profileName } = req.body;
    const settings = await getSettings(session.shop);
    const activeProfile = profileName || settings.active_profile || 'avery_6460';
    const profileConfig = settings.profiles?.[activeProfile] || getDefaultSettings().profiles.avery_6460;
    const testMode = mode || settings.default_mode || 'barcode';

    const pdfBuffer = await generateAlignmentTestPDF(profileConfig, testMode);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="alignment-test-${testMode}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    log('ERROR', 'Failed to generate alignment test', { error: err.message });
    res.status(500).json({ error: 'Failed to generate alignment test' });
  }
});

// ─── API: Print History ──────────────────────────────────────────────────────

app.get('/api/history', async (req, res) => {
  try {
    const session = await verifySession(req, res);
    if (!session) return;

    const history = await getPrintHistory(session.shop);
    res.json({ history });
  } catch (err) {
    log('ERROR', 'Failed to get print history', { error: err.message });
    res.status(500).json({ error: 'Failed to get print history' });
  }
});

// ─── Start Server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  log('SUCCESS', `🏷️  Shopify Labels running on port ${PORT}`);
  log('INFO', `Environment: ${IS_PRODUCTION ? 'production' : 'development'}`);
  log('INFO', `App URL: ${process.env.APP_URL}`);
});
