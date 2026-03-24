// Backfill endpoint - fetch March data from Amazon SP-API Reports
// POST /api/backfill with x-admin-token header
// Body: { startDate: "2026-03-01", endDate: "2026-03-23" }

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const adminToken = req.headers['x-admin-token'];
  if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { startDate, endDate } = req.body;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Missing startDate or endDate' });
    }

    // Step 1: Get Amazon access token
    const tokenResponse = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: process.env.AMAZON_REFRESH_TOKEN,
        client_id: process.env.AMAZON_LWA_CLIENT_ID,
        client_secret: process.env.AMAZON_LWA_CLIENT_SECRET
      })
    });

    if (!tokenResponse.ok) {
      return res.status(500).json({ error: 'Failed to get Amazon token' });
    }

    const { access_token } = await tokenResponse.json();

    // Step 2: Request report
    const reportResponse = await fetch('https://sellingpartnerapi-na.amazon.com/reports/2021-06-30/reports', {
      method: 'POST',
      headers: {
        'x-amz-access-token': access_token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        reportType: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
        marketplaceIds: [process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'],
        dataStartTime: new Date(startDate).toISOString(),
        dataEndTime: new Date(endDate + 'T23:59:59').toISOString()
      })
    });

    if (!reportResponse.ok) {
      const error = await reportResponse.text();
      return res.status(500).json({ error: 'Failed to request report', details: error });
    }

    const { reportId } = await reportResponse.json();

    // Step 3: Poll for report completion (max 5 minutes)
    let reportDocumentId = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds

      const statusResponse = await fetch(
        `https://sellingpartnerapi-na.amazon.com/reports/2021-06-30/reports/${reportId}`,
        { headers: { 'x-amz-access-token': access_token } }
      );

      if (!statusResponse.ok) {
        return res.status(500).json({ error: 'Failed to check report status' });
      }

      const statusData = await statusResponse.json();

      if (statusData.processingStatus === 'DONE') {
        reportDocumentId = statusData.reportDocumentId;
        break;
      } else if (statusData.processingStatus === 'FATAL' || statusData.processingStatus === 'CANCELLED') {
        return res.status(500).json({ error: `Report failed: ${statusData.processingStatus}` });
      }
    }

    if (!reportDocumentId) {
      return res.status(500).json({ error: 'Report generation timed out' });
    }

    // Step 4: Get download URL
    const docResponse = await fetch(
      `https://sellingpartnerapi-na.amazon.com/reports/2021-06-30/documents/${reportDocumentId}`,
      { headers: { 'x-amz-access-token': access_token } }
    );

    if (!docResponse.ok) {
      return res.status(500).json({ error: 'Failed to get document URL' });
    }

    const { url: downloadUrl } = await docResponse.json();

    // Step 5: Download report
    const downloadResponse = await fetch(downloadUrl);
    if (!downloadResponse.ok) {
      return res.status(500).json({ error: 'Failed to download report' });
    }

    const reportText = await downloadResponse.text();
    const lines = reportText.split('\n').filter(l => l.trim());

    if (lines.length < 2) {
      return res.status(500).json({ error: 'Empty report' });
    }

    // Step 6: Parse report
    const headers = lines[0].split('\t');
    const rows = [];

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split('\t');
      const row = {};
      headers.forEach((h, idx) => {
        row[h] = values[idx] || '';
      });
      rows.push(row);
    }

    // Step 7: Transform and write to KV
    const transactionsByMonth = {};

    for (const row of rows) {
      const dateTime = row['date/time'] || '';
      if (!dateTime) continue;

      // Parse "Mar 1, 2026 12:52:57 AM PST" to "2026-03-01"
      const datePart = dateTime.split(' ').slice(0, 3).join(' ');
      const parsed = new Date(datePart);
      if (isNaN(parsed)) continue;

      const date = parsed.toISOString().split('T')[0];
      const month = date.substring(0, 7);

      if (!transactionsByMonth[month]) {
        transactionsByMonth[month] = [];
      }

      transactionsByMonth[month].push([
        date,
        row['order id'] || '',
        row['sku'] || '',
        '',
        row['type'] || 'Order',
        row['fulfillment'] || 'Seller',
        parseFloat(row['quantity']) || 0,
        parseFloat(row['product sales']) || 0,
        parseFloat(row['shipping credits']) || 0,
        parseFloat(row['gift wrap credits']) || 0,
        parseFloat(row['promotional rebates']) || 0,
        (parseFloat(row['product sales tax']) || 0) + (parseFloat(row['shipping credits tax']) || 0),
        parseFloat(row['selling fees']) || 0,
        parseFloat(row['fba fees']) || 0,
        parseFloat(row['other transaction fees']) || 0,
        parseFloat(row['other']) || 0,
        parseFloat(row['total']) || 0
      ]);
    }

    // Write to KV
    const kvHeaders = ['date', 'order-id', 'sku', 'asin', 'type', 'fulfillment', 'quantity',
      'product sales', 'shipping credits', 'gift wrap credits', 'promotional rebates',
      'sales tax collected', 'selling fees', 'fba fees', 'other transaction fees',
      'other', 'total'];

    let totalRows = 0;
    for (const [month, rows] of Object.entries(transactionsByMonth)) {
      await kv.set(`transactions:${month}`, JSON.stringify({ headers: kvHeaders, rows }));
      totalRows += rows.length;
    }

    res.json({
      success: true,
      totalRows,
      months: Object.keys(transactionsByMonth)
    });

  } catch (error) {
    console.error('Backfill error:', error);
    res.status(500).json({ error: error.message });
  }
}
