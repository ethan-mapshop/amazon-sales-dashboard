import { kv } from '@vercel/kv';

// ─── ROUTER ──────────────────────────────────────────────────────────────────
//  GET  ?action=get                          — read full catalog
//  POST ?action=bulk-upsert                  — upsert an array of products by SKU
//  POST ?action=replace                      — wholesale replace (used by migration)
//  POST ?action=migrate                      — one-time: copy from Sheets Products tab
//  GET  ?action=last-updated                 — when was the catalog last written
//
// Schema per product: { sku, name, brand, fulfillment, cost, asin, type }
// KV layout:
//   products            → array of product objects (source of truth)
//   products:updated-at → ISO timestamp of the last write
export default async function handler(req, res) {
  const { action } = req.query;
  if (!action) return res.status(400).json({ error: 'Action parameter required' });

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    if (action === 'get')          return handleGet(req, res);
    if (action === 'last-updated') return handleLastUpdated(req, res);
  }
  if (req.method === 'POST') {
    if (action === 'bulk-upsert') return handleBulkUpsert(req, res);
    if (action === 'replace')     return handleReplace(req, res);
    if (action === 'migrate')     return handleMigrate(req, res);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ─── GET ─────────────────────────────────────────────────────────────────────
async function handleGet(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const [products, updatedAt] = await Promise.all([
      kv.get('products'),
      kv.get('products:updated-at')
    ]);

    return res.status(200).json({
      success: true,
      products: products || [],
      updatedAt: updatedAt || null
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to load products: ' + error.message });
  }
}

async function handleLastUpdated(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });
    const updatedAt = await kv.get('products:updated-at');
    return res.status(200).json({ success: true, updatedAt: updatedAt || null });
  } catch (error) {
    return res.status(500).json({ error: 'Failed: ' + error.message });
  }
}

// ─── BULK UPSERT ─────────────────────────────────────────────────────────────
// Merges the provided products into the existing catalog keyed by SKU.
// Same semantics as the current Sheets-based flow (update-or-add-by-SKU).
async function handleBulkUpsert(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const incoming = Array.isArray(req.body?.products) ? req.body.products : null;
    if (!incoming) return res.status(400).json({ error: 'products array required' });

    const existing = (await kv.get('products')) || [];
    const bySku = {};
    for (const p of existing) if (p?.sku) bySku[p.sku] = p;

    let addedCount = 0;
    let updatedCount = 0;
    for (const p of incoming) {
      const sku = p?.sku;
      if (!sku) continue;
      const normalized = normalizeProduct(p);
      if (bySku[sku]) {
        bySku[sku] = { ...bySku[sku], ...normalized };
        updatedCount++;
      } else {
        bySku[sku] = normalized;
        addedCount++;
      }
    }

    const merged = Object.values(bySku).sort((a, b) => a.sku.localeCompare(b.sku));
    await kv.set('products', merged);
    await kv.set('products:updated-at', new Date().toISOString());

    return res.status(200).json({
      success: true,
      addedCount,
      updatedCount,
      total: merged.length
    });
  } catch (error) {
    return res.status(500).json({ error: 'Bulk upsert failed: ' + error.message });
  }
}

// ─── REPLACE ─────────────────────────────────────────────────────────────────
// Nukes the catalog and writes the provided array wholesale. Use with care.
async function handleReplace(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const incoming = Array.isArray(req.body?.products) ? req.body.products : null;
    if (!incoming) return res.status(400).json({ error: 'products array required' });

    const normalized = incoming
      .filter(p => p?.sku)
      .map(normalizeProduct)
      .sort((a, b) => a.sku.localeCompare(b.sku));

    await kv.set('products', normalized);
    await kv.set('products:updated-at', new Date().toISOString());

    return res.status(200).json({ success: true, total: normalized.length });
  } catch (error) {
    return res.status(500).json({ error: 'Replace failed: ' + error.message });
  }
}

// ─── MIGRATE ─────────────────────────────────────────────────────────────────
// One-time: pull the Products tab from a Google Sheet and write to KV.
// POST body: { spreadsheetId }    (the user's Google token comes via header)
async function handleMigrate(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });
    const accessToken = req.headers.authorization?.replace('Bearer ', '');

    const spreadsheetId = req.body?.spreadsheetId;
    if (!spreadsheetId) return res.status(400).json({ error: 'spreadsheetId required' });

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Products`;
    const sheetsRes = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!sheetsRes.ok) {
      return res.status(502).json({ error: `Failed to read Products tab: ${sheetsRes.status}` });
    }

    const body = await sheetsRes.json();
    const rows = body.values || [];
    if (rows.length < 2) {
      return res.status(200).json({ success: true, total: 0, message: 'Products tab was empty' });
    }

    // Normalize header names (case-insensitive) so we accept the exact Sheet
    // columns the user described: sku, name, brand, fulfillment, cost, asin, type.
    const headerRow = rows[0].map(h => String(h || '').trim().toLowerCase());
    const FIELDS = ['sku', 'name', 'brand', 'fulfillment', 'cost', 'asin', 'type'];
    const colIdx = {};
    for (const f of FIELDS) colIdx[f] = headerRow.indexOf(f);

    if (colIdx.sku === -1) {
      return res.status(400).json({ error: 'Products tab missing a "sku" column' });
    }

    const products = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const sku = (row[colIdx.sku] ?? '').toString().trim();
      if (!sku) continue;
      const p = { sku };
      for (const f of FIELDS) {
        if (f === 'sku' || colIdx[f] === -1) continue;
        p[f] = (row[colIdx[f]] ?? '').toString().trim();
      }
      products.push(normalizeProduct(p));
    }

    products.sort((a, b) => a.sku.localeCompare(b.sku));
    await kv.set('products', products);
    await kv.set('products:updated-at', new Date().toISOString());

    return res.status(200).json({
      success: true,
      total: products.length,
      message: `Migrated ${products.length} products from Sheets to Upstash`
    });
  } catch (error) {
    return res.status(500).json({ error: 'Migrate failed: ' + error.message });
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

// Keep only the fields we care about, coerce cost to a number so downstream
// math doesn't have to. Everything else is a trimmed string.
function normalizeProduct(p) {
  const str = (v) => (v == null ? '' : String(v).trim());
  const cost = parseFloat(p.cost);
  return {
    sku:         str(p.sku),
    name:        str(p.name),
    brand:       str(p.brand),
    fulfillment: str(p.fulfillment),
    cost:        Number.isFinite(cost) ? cost : 0,
    asin:        str(p.asin),
    type:        str(p.type)
  };
}

async function verifyGoogleToken(req) {
  const accessToken = req.headers.authorization?.replace('Bearer ', '');
  if (!accessToken) return { ok: false, error: 'No access token provided' };
  const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
  if (!verify.ok) return { ok: false, error: 'Invalid access token' };
  return { ok: true };
}
