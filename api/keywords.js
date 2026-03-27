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

  // Handle POST request
  if (req.method === 'POST' && action === 'save') {
    return handleSave(req, res);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// SAVE: Save keyword data to Upstash
async function handleSave(req, res) {
  try {
    const accessToken = req.headers.authorization?.replace('Bearer ', '');
    
    if (!accessToken) {
      return res.status(401).json({ error: 'No access token provided' });
    }

    const verifyResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
    
    if (!verifyResponse.ok) {
      return res.status(401).json({ error: 'Invalid access token' });
    }

    const { quarter, keywords } = req.body;

    if (!quarter || !keywords || !Array.isArray(keywords)) {
      return res.status(400).json({ error: 'Missing quarter or keywords data' });
    }

    const kvKey = `keywords:${quarter}`;
    await kv.set(kvKey, keywords);

    const quartersKey = 'keywords:quarters';
    let quartersData = await kv.get(quartersKey);
    let quarters = quartersData || [];
    
    if (!quarters.includes(quarter)) {
      quarters.push(quarter);
      
      // Keep only last 2 quarters in Upstash
      if (quarters.length > 2) {
        const oldestQuarter = quarters.shift();
        await kv.del(`keywords:${oldestQuarter}`);
      }
      
      await kv.set(quartersKey, quarters);
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

// GET: Retrieve keyword data
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

    const quartersKey = 'keywords:quarters';
    const quartersData = await kv.get(quartersKey);
    const quarters = quartersData || [];

    const keywordData = {};
    
    for (const quarter of quarters) {
      const kvKey = `keywords:${quarter}`;
      const data = await kv.get(kvKey);
      
      if (data) {
        keywordData[quarter] = data;
      }
    }

    return res.status(200).json({ 
      quarters,
      data: keywordData
    });

  } catch (error) {
    console.error('Error retrieving keyword data:', error);
    return res.status(500).json({ error: 'Failed to retrieve keyword data: ' + error.message });
  }
}
