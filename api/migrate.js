// Phase 2.5: One-Time Migration Script
// Moves all historical data from Google Sheets → Vercel KV
// POST /api/migrate with x-admin-token header

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify admin token
  const adminToken = req.headers['x-admin-token'];
  if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized - Invalid admin token' });
  }

  try {
    console.log('🚀 Starting migration...');

    // Get Google Sheets credentials from request body
    const { accessToken, spreadsheetId } = req.body;
    
    if (!accessToken || !spreadsheetId) {
      return res.status(400).json({ 
        error: 'Missing required fields: accessToken, spreadsheetId' 
      });
    }

    // Fetch all 4 sheets from Google Sheets
    console.log('📥 Fetching data from Google Sheets...');
    const sheets = ['Transactions', 'ShippingCosts', 'ProductAdSpend', 'BrandAdSpend'];
    const sheetData = {};

    for (const sheetName of sheets) {
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${sheetName}`;
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch ${sheetName}: ${response.statusText}`);
      }

      const data = await response.json();
      sheetData[sheetName] = data.values || [];
      console.log(`  ✓ ${sheetName}: ${data.values?.length || 0} rows`);
    }

    // Migrate each dataset
    const results = {
      transactions: await migrateTransactions(sheetData.Transactions),
      shipping: await migrateShipping(sheetData.ShippingCosts),
      productAds: await migrateProductAds(sheetData.ProductAdSpend),
      brandAds: await migrateBrandAds(sheetData.BrandAdSpend)
    };

    // Set migration metadata
    await kv.set('meta:migration', {
      completedAt: new Date().toISOString(),
      rowCounts: {
        transactions: results.transactions.totalRows,
        shipping: results.shipping.totalRows,
        productAds: results.productAds.totalRows,
        brandAds: results.brandAds.totalRows
      },
      monthlyBreakdown: {
        transactions: results.transactions.byMonth,
        shipping: results.shipping.byMonth,
        productAds: results.productAds.byMonth,
        brandAds: results.brandAds.byMonth
      }
    });

    console.log('✅ Migration complete!');

    res.status(200).json({
      success: true,
      message: 'Migration completed successfully',
      results: {
        transactions: results.transactions.totalRows,
        shipping: results.shipping.totalRows,
        productAds: results.productAds.totalRows,
        brandAds: results.brandAds.totalRows,
        totalRows: results.transactions.totalRows + 
                   results.shipping.totalRows + 
                   results.productAds.totalRows + 
                   results.brandAds.totalRows
      }
    });

  } catch (error) {
    console.error('❌ Migration failed:', error);
    res.status(500).json({ 
      error: 'Migration failed', 
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}

// Migrate Transactions - shard by month
async function migrateTransactions(rows) {
  if (!rows || rows.length < 2) {
    return { totalRows: 0, byMonth: {} };
  }

  const headers = rows[0].map(h => h.toLowerCase());
  const dateIdx = headers.findIndex(h => h.includes('date'));
  
  if (dateIdx === -1) {
    throw new Error('Transactions: Could not find date column');
  }

  // Group by month
  const byMonth = {};
  
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const dateStr = row[dateIdx];
    
    if (!dateStr) continue;
    
    // Extract YYYY-MM
    const monthKey = dateStr.substring(0, 7); // "2025-01"
    
    if (!byMonth[monthKey]) {
      byMonth[monthKey] = [];
    }
    
    // Store entire row as array
    byMonth[monthKey].push(row);
  }

  // Write each month to KV
  let totalRows = 0;
  const monthCounts = {};
  
  for (const [month, data] of Object.entries(byMonth)) {
    const key = `transactions:${month}`;
    await kv.set(key, JSON.stringify({ headers, rows: data }));
    monthCounts[month] = data.length;
    totalRows += data.length;
    console.log(`  ✓ Transactions ${month}: ${data.length} rows`);
  }

  return { totalRows, byMonth: monthCounts };
}

// Migrate ShippingCosts - shard by month
async function migrateShipping(rows) {
  if (!rows || rows.length < 2) {
    return { totalRows: 0, byMonth: {} };
  }

  const headers = rows[0].map(h => h.toLowerCase());
  const dateIdx = headers.findIndex(h => h.includes('date'));
  
  if (dateIdx === -1) {
    throw new Error('ShippingCosts: Could not find date column');
  }

  const byMonth = {};
  
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const dateStr = row[dateIdx];
    
    if (!dateStr) continue;
    
    const monthKey = dateStr.substring(0, 7);
    
    if (!byMonth[monthKey]) {
      byMonth[monthKey] = [];
    }
    
    byMonth[monthKey].push(row);
  }

  let totalRows = 0;
  const monthCounts = {};
  
  for (const [month, data] of Object.entries(byMonth)) {
    const key = `shipping:${month}`;
    await kv.set(key, JSON.stringify({ headers, rows: data }));
    monthCounts[month] = data.length;
    totalRows += data.length;
    console.log(`  ✓ Shipping ${month}: ${data.length} rows`);
  }

  return { totalRows, byMonth: monthCounts };
}

// Migrate ProductAdSpend - shard by month
async function migrateProductAds(rows) {
  if (!rows || rows.length < 2) {
    return { totalRows: 0, byMonth: {} };
  }

  const headers = rows[0].map(h => h.toLowerCase());
  const dateIdx = headers.findIndex(h => h.includes('date'));
  
  if (dateIdx === -1) {
    throw new Error('ProductAdSpend: Could not find date column');
  }

  const byMonth = {};
  
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const dateStr = row[dateIdx];
    
    if (!dateStr) continue;
    
    const monthKey = dateStr.substring(0, 7);
    
    if (!byMonth[monthKey]) {
      byMonth[monthKey] = [];
    }
    
    byMonth[monthKey].push(row);
  }

  let totalRows = 0;
  const monthCounts = {};
  
  for (const [month, data] of Object.entries(byMonth)) {
    const key = `productads:${month}`;
    await kv.set(key, JSON.stringify({ headers, rows: data }));
    monthCounts[month] = data.length;
    totalRows += data.length;
    console.log(`  ✓ ProductAds ${month}: ${data.length} rows`);
  }

  return { totalRows, byMonth: monthCounts };
}

// Migrate BrandAdSpend - shard by month
async function migrateBrandAds(rows) {
  if (!rows || rows.length < 2) {
    return { totalRows: 0, byMonth: {} };
  }

  const headers = rows[0].map(h => h.toLowerCase());
  const dateIdx = headers.findIndex(h => h.includes('date'));
  
  if (dateIdx === -1) {
    throw new Error('BrandAdSpend: Could not find date column');
  }

  const byMonth = {};
  
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const dateStr = row[dateIdx];
    
    if (!dateStr) continue;
    
    const monthKey = dateStr.substring(0, 7);
    
    if (!byMonth[monthKey]) {
      byMonth[monthKey] = [];
    }
    
    byMonth[monthKey].push(row);
  }

  let totalRows = 0;
  const monthCounts = {};
  
  for (const [month, data] of Object.entries(byMonth)) {
    const key = `brandads:${month}`;
    await kv.set(key, JSON.stringify({ headers, rows: data }));
    monthCounts[month] = data.length;
    totalRows += data.length;
    console.log(`  ✓ BrandAds ${month}: ${data.length} rows`);
  }

  return { totalRows, byMonth: monthCounts };
}
