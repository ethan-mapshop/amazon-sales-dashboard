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
  const lines = text.split('\n').filter(line => line.trim());
  
  console.log(`📄 Report has ${lines.length} lines`);
  
  if (lines.length < 2) {
    return [];
  }

  // Parse TSV (tab-separated values)
  const headers = lines[0].split('\t').map(h => h.trim());
  console.log(`📋 Headers: ${headers.slice(0, 10).join(', ')}...`);
  
  const transactions = [];

  // Create column index map
  const colIndex = {};
  headers.forEach((header, index) => {
    colIndex[header.toLowerCase()] = index;
  });

  console.log(`🔍 Looking for 'date/time' column at index: ${colIndex['date/time']}`);
  console.log(`🔍 Looking for 'order id' column at index: ${colIndex['order id']}`);

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split('\t');
    
    // Parse date/time to YYYY-MM-DD format
    const dateTime = values[colIndex['date/time']] || '';
    let date = '';
    if (dateTime) {
      // Parse "Mar 1, 2026 12:52:57 AM PST" format
      const datePart = dateTime.split(' ').slice(0, 3).join(' '); // "Mar 1, 2026"
      const parsed = new Date(datePart);
      if (!isNaN(parsed)) {
        date = parsed.toISOString().split('T')[0]; // "2026-03-01"
      } else {
        if (i === 1) console.log(`⚠️ Failed to parse date: "${dateTime}" -> "${datePart}"`);
      }
    } else {
      if (i === 1) console.log(`⚠️ No date/time value found in row ${i}`);
    }
    
    if (!date) {
      if (i <= 3) console.log(`⚠️ Skipping row ${i} - no valid date`);
      continue; // Skip rows without valid date
    }

    const transaction = {
      'date': date,
      'order-id': values[colIndex['order id']] || '',
      'sku': values[colIndex['sku']] || '',
      'asin': '', // Not in this report
      'type': values[colIndex['type']] || 'Order',
      'fulfillment': values[colIndex['fulfillment']] || 'Seller',
      'quantity': parseFloat(values[colIndex['quantity']]) || 0,
      'product sales': parseFloat(values[colIndex['product sales']]) || 0,
      'shipping credits': parseFloat(values[colIndex['shipping credits']]) || 0,
      'gift wrap credits': parseFloat(values[colIndex['gift wrap credits']]) || 0,
      'promotional rebates': parseFloat(values[colIndex['promotional rebates']]) || 0,
      'sales tax collected': (parseFloat(values[colIndex['product sales tax']]) || 0) + (parseFloat(values[colIndex['shipping credits tax']]) || 0),
      'selling fees': parseFloat(values[colIndex['selling fees']]) || 0,
      'fba fees': parseFloat(values[colIndex['fba fees']]) || 0,
      'other transaction fees': parseFloat(values[colIndex['other transaction fees']]) || 0,
      'other': parseFloat(values[colIndex['other']]) || 0,
      'total': parseFloat(values[colIndex['total']]) || 0
    };

    // Only include if it has required fields
    if (transaction['order-id'] && transaction['sku']) {
      transactions.push(transaction);
      if (i === 1) console.log(`✅ First transaction parsed: ${transaction['order-id']}, $${transaction['product sales']}`);
    } else {
      if (i <= 3) console.log(`⚠️ Skipping row ${i} - missing order-id or sku`);
    }
  }

  console.log(`✅ Parsed ${transactions.length} transactions total`);
  return transactions;
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
    
    const existing = await kv.get(key);
    let existingRows = [];
    
    if (existing) {
      const parsed = typeof existing === 'string' ? JSON.parse(existing) : existing;
      existingRows = parsed.rows || [];
    }
    
    const allRows = [...existingRows, ...newRows];
    
    await kv.set(key, JSON.stringify({ headers, rows: allRows }));
    
    monthCounts[month] = newRows.length;
    totalRows += newRows.length;
    console.log(`  ✓ Shipping ${month}: +${newRows.length} rows (total: ${allRows.length})`);
  }

  return { totalRows, byMonth: monthCounts };
}
