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
    
    // Fetch orders from SP-API
    const orders = await fetchAmazonOrders(accessToken, startDate, endDate);
    
    // Transform to our transaction format
    const transactions = [];
    
    for (const order of orders) {
      // Fetch order items
      const items = await fetchOrderItems(accessToken, order.AmazonOrderId);
      
      for (const item of items) {
        transactions.push({
          date: order.PurchaseDate?.split('T')[0] || startDate,
          'order-id': order.AmazonOrderId,
          sku: item.SellerSKU,
          asin: item.ASIN,
          type: 'Order',
          fulfillment: order.FulfillmentChannel === 'AFN' ? 'Amazon' : 'Seller',
          quantity: parseInt(item.QuantityOrdered) || 1,
          'product sales': parseFloat(item.ItemPrice?.Amount || 0),
          'shipping credits': parseFloat(item.ShippingPrice?.Amount || 0),
          'gift wrap credits': parseFloat(item.GiftWrapPrice?.Amount || 0),
          'promotional rebates': parseFloat(item.PromotionDiscount?.Amount || 0) * -1,
          'sales tax collected': parseFloat(item.ItemTax?.Amount || 0),
          'selling fees': parseFloat(item.Commission?.Amount || 0) * -1,
          'fba fees': order.FulfillmentChannel === 'AFN' ? parseFloat(item.ItemPrice?.Amount || 0) * 0.15 * -1 : 0, // Estimate
          'other transaction fees': 0,
          'other': 0,
          total: parseFloat(item.ItemPrice?.Amount || 0)
        });
      }
    }
    
    return transactions;
  } catch (error) {
    console.error('Error fetching Amazon transactions:', error);
    throw new Error(`Amazon SP-API error: ${error.message}`);
  }
}

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

async function fetchAmazonOrders(accessToken, startDate, endDate) {
  const marketplaceId = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER';
  
  // Convert dates to ISO format
  const createdAfter = new Date(startDate).toISOString();
  const createdBefore = new Date(endDate + 'T23:59:59').toISOString();
  
  const url = `https://sellingpartnerapi-na.amazon.com/orders/v0/orders?MarketplaceIds=${marketplaceId}&CreatedAfter=${createdAfter}&CreatedBefore=${createdBefore}`;
  
  const response = await fetch(url, {
    headers: {
      'x-amz-access-token': accessToken,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to fetch orders: ${error}`);
  }

  const data = await response.json();
  return data.payload?.Orders || [];
}

async function fetchOrderItems(accessToken, orderId) {
  const url = `https://sellingpartnerapi-na.amazon.com/orders/v0/orders/${orderId}/orderItems`;
  
  const response = await fetch(url, {
    headers: {
      'x-amz-access-token': accessToken,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    const error = await response.text();
    console.warn(`Failed to fetch items for order ${orderId}:`, error);
    return [];
  }

  const data = await response.json();
  return data.payload?.OrderItems || [];
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
