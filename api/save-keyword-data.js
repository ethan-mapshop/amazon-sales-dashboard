import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const accessToken = req.headers.authorization?.replace('Bearer ', '');
    
    if (!accessToken) {
      return res.status(401).json({ error: 'No access token provided' });
    }

    // Verify Google token
    const verifyResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
    
    if (!verifyResponse.ok) {
      return res.status(401).json({ error: 'Invalid access token' });
    }

    const { quarter, keywords } = req.body;

    if (!quarter || !keywords || !Array.isArray(keywords)) {
      return res.status(400).json({ error: 'Missing quarter or keywords data' });
    }

    // Store keyword data in Upstash with quarter key
    const kvKey = `keywords:${quarter}`;
    await kv.set(kvKey, JSON.stringify(keywords));

    // Track which quarters are stored
    const quartersKey = 'keywords:quarters';
    let quarters = await kv.get(quartersKey);
    
    if (!quarters) {
      quarters = [];
    }
    
    if (!quarters.includes(quarter)) {
      quarters.push(quarter);
      
      // Keep only last 2 quarters in Upstash
      if (quarters.length > 2) {
        const oldestQuarter = quarters.shift();
        await kv.del(`keywords:${oldestQuarter}`);
      }
      
      await kv.set(quartersKey, JSON.stringify(quarters));
    }

    return res.status(200).json({ 
      success: true,
      quarter,
      keywordCount: keywords.length,
      storedQuarters: quarters
    });

  } catch (error) {
    console.error('Error saving keyword data:', error);
    return res.status(500).json({ error: 'Failed to save keyword data: ' + error.message });
  }
}
