// Backfill endpoint - fetch historical data and write to KV
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

    // Fetch data from all sources
    const [transactions, shipping] = await Promise.all([
      fetchAmazonTransactions(startDate, endDate),
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

// ==================== AMAZON SP-API ====================

async function fetchAmazonTransactions(startDate, endDate) {
  try {
    // Get access token from LWA (Login with Amazon)
    const accessToken = await getAmazonAccessToken();
    
    // Request the transaction report
    const reportId = await requestReport(accessToken, startDate, endDate);
    
    // Poll until report is ready
    const reportDocumentId = await pollReportStatus(accessToken, reportId);
    
    // Get download URL
    const downloadUrl = await getReportDownloadUrl(accessToken, reportDocumentId);
    
    // Download and parse the report
    const transactions = await downloadAndParseReport(downloadUrl, startDate);
    
    return transactions;
  } catch (error) {
    console.error('Error fetching Amazon transactions:', error);
    throw new Error(`Amazon SP-API error: ${error.message}`);
  }
}

async function requestReport(accessToken, startDate, endDate) {
  const response = await fetch('https://sellingpartnerapi-na.amazon.com/reports/2021-06-30/reports', {
    method: 'POST',
    headers: {
      'x-amz-access-token': accessToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      reportType: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
      marketplaceIds: [process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'],
      dataStartTime: new Date(startDate).toISOString(),
      dataEndTime: new Date(endDate + 'T23:59:59').toISOString()
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to request report: ${error}`);
  }

  const data = await response.json();
  return data.reportId;
}

async function pollReportStatus(accessToken, reportId) {
  // Poll every 10 seconds for up to 5 minutes
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    const response = await fetch(
      `https://sellingpartnerapi-na.amazon.com/reports/2021-06-30/reports/${reportId}`,
      { headers: { 'x-amz-access-token': accessToken } }
    );

    if (!response.ok) {
      throw new Error('Failed to check report status');
    }

    const data = await response.json();
    
    if (data.processingStatus === 'DONE') {
      return data.reportDocumentId;
    } else if (data.processingStatus === 'FATAL' || data.processingStatus === 'CANCELLED') {
      throw new Error(`Report failed: ${data.processingStatus}`);
    }
  }
  
  throw new Error('Report generation timed out');
}

async function getReportDownloadUrl(accessToken, reportDocumentId) {
  const response = await fetch(
    `https://sellingpartnerapi-na.amazon.com/reports/2021-06-30/documents/${reportDocumentId}`,
    { headers: { 'x-amz-access-token': accessToken } }
  );

  if (!response.ok) {
    throw new Error('Failed to get download URL');
  }

  const data = await response.json();
  return data.url;
}

async function downloadAndParseReport(url, startDate) {
  const response = await fetch(url);
  
  if (!response.ok) {
    throw new Error('Failed to download report');
  }

  const text = await response.text();
  const lines = text.split('\n').filter(line => line.trim());
  
  if (lines.length < 2) {
    return [];
  }

  const headers = lines[0].split('\t');
  const transactions = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split('\t');
    const row = {};
    
    headers.forEach((header, index) => {
      row[header] = values[index] || '';
    });

    // Parse date from "Mar 1, 2026 12:52:57 AM PST" format
    const dateTime = row['date/time'] || '';
    let date = startDate;
    if (dateTime) {
      const datePart = dateTime.split(' ').slice(0, 3).join(' ');
      const parsed = new Date(datePart);
      if (!isNaN(parsed)) {
        date = parsed.toISOString().split('T')[0];
      }
    }

    transactions.push({
      date: date,
      'order-id': row['order id'] || '',
      sku: row['sku'] || '',
      asin: '',
      type: row['type'] || 'Order',
      fulfillment: row['fulfillment'] || 'Seller',
      quantity: parseFloat(row['quantity']) || 0,
      'product sales': parseFloat(row['product sales']) || 0,
      'shipping credits': parseFloat(row['shipping credits']) || 0,
      'gift wrap credits': parseFloat(row['gift wrap credits']) || 0,
      'promotional rebates': parseFloat(row['promotional rebates']) || 0,
      'sales tax collected': (parseFloat(row['product sales tax']) || 0) + (parseFloat(row['shipping credits tax']) || 0),
      'selling fees': parseFloat(row['selling fees']) || 0,
      'fba fees': parseFloat(row['fba fees']) || 0,
      'other transaction fees': parseFloat(row['other transaction fees']) || 0,
      'other': parseFloat(row['other']) || 0,
      total: parseFloat(row['total']) || 0
    });
  }

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
    if (!byMonth[month]) {
      byMonth[month] = [];
    }
    
    // Convert to array format
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

  // Write each month to KV (merge with existing data)
  const headers = ['date', 'order-id', 'sku', 'asin', 'type', 'fulfillment', 'quantity', 
                   'product sales', 'shipping credits', 'gift wrap credits', 'promotional rebates',
                   'sales tax collected', 'selling fees', 'fba fees', 'other transaction fees', 
                   'other', 'total'];
  
  let totalRows = 0;
  const monthCounts = {};
  
  for (const [month, newRows] of Object.entries(byMonth)) {
    const key = `transactions:${month}`;
    
    // Get existing data for this month
    const existing = await kv.get(key);
    let existingRows = [];
    
    if (existing) {
      const parsed = typeof existing === 'string' ? JSON.parse(existing) : existing;
      existingRows = parsed.rows || [];
    }
    
    // Merge (append new rows)
    const allRows = [...existingRows, ...newRows];
    
    // Write back
    await kv.set(key, JSON.stringify({ headers, rows: allRows }));
    
    monthCounts[month] = newRows.length;
    totalRows += newRows.length;
    console.log(`  ✓ Transactions ${month}: +${newRows.length} rows (total: ${allRows.length})`);
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
