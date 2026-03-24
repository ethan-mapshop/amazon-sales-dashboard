// Cleanup endpoint - delete data for specific months from KV
// POST /api/cleanup with x-admin-token header
// Body: { months: ["2026-03"] }

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
    const { months } = req.body;
    
    if (!months || !Array.isArray(months) || months.length === 0) {
      return res.status(400).json({ 
        error: 'Missing required field: months (array of YYYY-MM strings)' 
      });
    }

    console.log(`🗑️  Cleaning up data for months: ${months.join(', ')}`);

    const results = {
      deleted: [],
      notFound: []
    };

    for (const month of months) {
      // Delete transactions for this month
      const transKey = `transactions:${month}`;
      const transDeleted = await kv.del(transKey);
      
      // Delete shipping for this month
      const shipKey = `shipping:${month}`;
      const shipDeleted = await kv.del(shipKey);
      
      // Delete product ads for this month
      const prodAdsKey = `productads:${month}`;
      const prodAdsDeleted = await kv.del(prodAdsKey);
      
      // Delete brand ads for this month
      const brandAdsKey = `brandads:${month}`;
      const brandAdsDeleted = await kv.del(brandAdsKey);
      
      if (transDeleted || shipDeleted || prodAdsDeleted || brandAdsDeleted) {
        results.deleted.push({
          month,
          transactions: transDeleted > 0,
          shipping: shipDeleted > 0,
          productAds: prodAdsDeleted > 0,
          brandAds: brandAdsDeleted > 0
        });
        console.log(`  ✓ Deleted data for ${month}`);
      } else {
        results.notFound.push(month);
        console.log(`  ⚠️  No data found for ${month}`);
      }
    }

    res.status(200).json({
      success: true,
      message: 'Cleanup completed',
      results
    });

  } catch (error) {
    console.error('❌ Cleanup failed:', error);
    res.status(500).json({ 
      error: 'Cleanup failed', 
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}
