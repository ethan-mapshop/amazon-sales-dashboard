import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  const { action } = req.query;

  if (!action) {
    return res.status(400).json({ error: 'Action parameter required' });
  }

  // Handle GET request
  if (req.method === 'GET' && action === 'get') {
    return handleGet(req, res);
  }

  // Handle POST requests
  if (req.method === 'POST') {
    if (action === 'sync') {
      return handleSync(req, res);
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// GET: Retrieve orders data from Upstash
async function handleGet(req, res) {
  try {
    const accessToken = req.headers.authorization?.replace('Bearer ', '');
    
    if (!accessToken) {
      return res.status(401).json({ error: 'No access token provided' });
    }

    const verifyResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
    
    if (!verifyResponse.ok) {
      return res.status(401).json({ error: 'Invalid access token' });
    }

    const ordersData = await kv.get('orders_data');
    
    return res.status(200).json({ 
      success: true,
      orders: ordersData || []
    });

  } catch (error) {
    console.error('Error retrieving orders:', error);
    return res.status(500).json({ error: 'Failed to retrieve orders: ' + error.message });
  }
}

// SYNC: Daily sync of yesterday's orders
async function handleSync(req, res) {
  try {
    // TODO: Implement Amazon Orders API integration
    // For now, return placeholder
    return res.status(200).json({
      success: true,
      message: 'Orders sync endpoint - implementation pending'
    });

  } catch (error) {
    console.error('Sync error:', error);
    return res.status(500).json({ error: 'Sync failed: ' + error.message });
  }
}
