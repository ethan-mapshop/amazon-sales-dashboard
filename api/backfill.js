// Backfill endpoint - fetch historical data using Reports API and write to KV
// POST /api/backfill with x-admin-token header
// Body: { startDate: "2026-03-01", endDate: "2026-03-24" }

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
    const { startDate, endDate } = req.body;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ 
        error: 'Missing required fields: startDate, endDate (YYYY-MM-DD format)' 
      });
    }

    console.log(`🔄 Starting backfill from ${startDate} to ${endDate}`);

    // Get SP-API access token
    const accessToken = await getAmazonAccessToken();

    // Fetch data from all sources
    const [transactions, shipping] = await Promise.all([
      fetchAmazonTransactionsReport(accessToken, startDate, endDate),
      fetchShipStationShipping(startDate, endDate)
    ]);

    console.log(`📊 Fetched: ${transactions.length} transactions, ${shipping.length} shipping records`);

    // Write to KV (sharded by month)
    const results = {
      transactions: await writeTransactionsToKV(transactions),
      shipping: await writeShippingToKV(shipping)
    };

    res.status(200).json({
      success: true,
      message: 'Backfill completed successfully',
      dateRange: { startDate, endDate },
      results
    });

  } catch (error) {
    console.error('❌ Backfill failed:', error);
    res.status(500).json({ 
      error: 'Backfill failed', 
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}

// ==================== AMAZON SP-API REPORTS ====================

async function getAmazonAccessToken() {
  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: process.env.AMAZON_REFRESH_TOKEN,
      client_id: process.env.AMAZON_LWA_CLIENT_ID,
      client_secret: process.env.AMAZON_LWA_CLIENT_SECRET
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get Amazon access token: ${error}`);
  }

  const data = await response.json();
  return data.access_token;
}

async function fetchAmazonTransactionsReport(accessToken, startDate, endDate) {
  const marketplaceIds = [process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'];
  
  console.log('📋 Requesting transaction report from Amazon...');
  
  // Step 1: Request the report
  const reportId = await requestTransactionReport(accessToken, marketplaceIds, startDate, endDate);
  
  console.log(`📋 Report requested, ID: ${reportId}`);
  
  // Step 2: Poll until report is ready (up to 5 minutes)
  const reportDocumentId = await pollReportStatus(accessToken, reportId);
  
  console.log(`📄 Report ready, document ID: ${reportDocumentId}`);
  
  // Step 3: Get download URL
  const downloadUrl = await getReportDocument(accessToken, reportDocumentId);
  
  console.log(`⬇️ Downloading report...`);
  
  // Step 4: Download and parse the report
  const transactions = await downloadAndParseReport(downloadUrl);
  
  console.log(`✅ Parsed ${transactions.length} transactions`);
  
  return transactions;
}

async function requestTransactionReport(accessToken, marketplaceIds, startDate, endDate) {
  // Convert dates to ISO format for API
  const dataStartTime = new Date(startDate).toISOString();
  const dataEndTime = new Date(endDate + 'T23:59:59').toISOString();
  
  const response = await fetch('https://sellingpartnerapi-na.amazon.com/reports/2021-06-30/reports', {
    method: 'POST',
    headers: {
      'x-amz-access-token': accessToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      reportType: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
      marketplaceIds: marketplaceIds,
      dataStartTime: dataStartTime,
      dataEndTime: dataEndTime
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to request report: ${error}`);
  }

  const data = await response.json();
  return data.reportId;
}

async function pollReportStatus(accessToken, reportId, maxAttempts = 30) {
  // Poll every 10 seconds, up to 5 minutes
  for (let i = 0; i < maxAttempts; i++) {
    const response = await fetch(`https://sellingpartnerapi-na.amazon.com/reports/2021-06-30/reports/${reportId}`, {
      headers: {
        'x-amz-access-token': accessToken
      }
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to check report status: ${error}`);
    }

    const data = await response.json();
    
    if (data.processingStatus === 'DONE') {
      return data.reportDocumentId;
    } else if (data.processingStatus === 'FATAL' || data.processingStatus === 'CANCELLED') {
      throw new Error(`Report processing failed with status: ${data.processingStatus}`);
    }
    
    // Wait 10 seconds before next poll
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
  
  throw new Error('Report generation timed out after 5 minutes');
}

async function getReportDocument(accessToken, reportDocumentId) {
  const response = await fetch(`https://sellingpartnerapi-na.amazon.com/reports/2021-06-30/documents/${reportDocumentId}`, {
    headers: {
      'x-amz-access-token': accessToken
    }
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get report document: ${error}`);
  }

  const data = await response.json();
  return data.url;
}

async function downloadAndParseReport(url) {
  const response = await fetch(url);
  
  if (!response.ok) {
    throw new Error('Failed to download report');
  }

  const text = await response.text();
  
  // Log first 2000 characters to see actual format
  console.log('═══════════════════════════════════════');
  console.log('📄 RAW REPORT FROM AMAZON API (first 2000 chars):');
  console.log(text.substring(0, 2000));
  console.log('═══════════════════════════════════════');
  
  const lines = text.split('\n').filter(line => line.trim());
  
  console.log(`\n📊 Total lines: ${lines.length}`);
  
  if (lines.length < 2) {
    console.log('❌ Report has fewer than 2 lines - cannot parse');
    return [];
  }

  console.log(`\n📋 First line (headers):\n${lines[0]}`);
  if (lines.length > 1) {
    console.log(`\n📋 Second line (first data row):\n${lines[1]}`);
  }
  
  return []; // Stop here - just return empty so we can see the logs
}

// ==================== SHIPSTATION ====================

async function fetchShipStationShipping(startDate, endDate) {
  try {
    const authHeader = 'Basic ' + Buffer.from(
      `${process.env.SHIPSTATION_API_KEY}:${process.env.SHIPSTATION_API_SECRET}`
    ).toString('base64');
    
    const url = `https://ssapi.shipstation.com/shipments?shipDateStart=${startDate}&shipDateEnd=${endDate}`;
    
    const response = await fetch(url, {
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to fetch ShipStation data: ${error}`);
    }

    const data = await response.json();
    const shipments = data.shipments || [];
    
    // Transform to our shipping format
    const shipping = shipments.map(s => ({
      'ship date': s.shipDate?.split('T')[0] || startDate,
      'order id': s.orderNumber,
      'shipping cost': parseFloat(s.shipmentCost) || 0
    }));
    
    return shipping;
  } catch (error) {
    console.error('Error fetching ShipStation data:', error);
    throw new Error(`ShipStation API error: ${error.message}`);
  }
}

// ==================== WRITE TO KV ====================

async function writeTransactionsToKV(transactions) {
  // Group by month
  const byMonth = {};
  
  transactions.forEach(t => {
    const month = t.date.substring(0, 7); // YYYY-MM
    
    if (!month || month.length !== 7) return;
    
    if (!byMonth[month]) {
      byMonth[month] = [];
    }
    
    // Convert transaction object to array format matching your Transactions sheet
    const row = [
      t.date,
      t['order-id'],
      t.sku,
      t.asin,
      t.type,
      t.fulfillment,
      t.quantity,
      t['product sales'],
      t['shipping credits'],
      t['gift wrap credits'],
      t['promotional rebates'],
      t['sales tax collected'],
      t['selling fees'],
      t['fba fees'],
      t['other transaction fees'],
      t['other'],
      t.total
    ];
    
    byMonth[month].push(row);
  });

  // Write each month to KV (overwrites existing data)
  const headers = ['date', 'order-id', 'sku', 'asin', 'type', 'fulfillment', 'quantity', 
                   'product sales', 'shipping credits', 'gift wrap credits', 'promotional rebates',
                   'sales tax collected', 'selling fees', 'fba fees', 'other transaction fees', 
                   'other', 'total'];
  
  let totalRows = 0;
  const monthCounts = {};
  
  for (const [month, newRows] of Object.entries(byMonth)) {
    const key = `transactions:${month}`;
    
    // Overwrite (not merge) - this replaces bad data with correct data
    await kv.set(key, JSON.stringify({ headers, rows: newRows }));
    
    monthCounts[month] = newRows.length;
    totalRows += newRows.length;
    console.log(`  ✓ Transactions ${month}: ${newRows.length} rows`);
  }

  return { totalRows, byMonth: monthCounts };
}

async function writeShippingToKV(shipping) {
  // Group by month
  const byMonth = {};
  
  shipping.forEach(s => {
    const month = s['ship date'].substring(0, 7);
    if (!byMonth[month]) {
      byMonth[month] = [];
    }
    
    const row = [
      s['ship date'],
      s['order id'],
      s['shipping cost']
    ];
    
    byMonth[month].push(row);
  });

  const headers = ['ship date', 'order id', 'shipping cost'];
  
  let totalRows = 0;
  const monthCounts = {};
  
  for (const [month, newRows] of Object.entries(byMonth)) {
    const key = `shipping:${month}`;
    
    // Overwrite (not merge) - replaces existing data
    await kv.set(key, JSON.stringify({ headers, rows: newRows }));
    
    monthCounts[month] = newRows.length;
    totalRows += newRows.length;
    console.log(`  ✓ Shipping ${month}: ${newRows.length} rows`);
  }

  return { totalRows, byMonth: monthCounts };
}
