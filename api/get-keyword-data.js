import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
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

    // Get list of stored quarters
    const quartersKey = 'keywords:quarters';
    const quartersData = await kv.get(quartersKey);
    const quarters = quartersData ? JSON.parse(quartersData) : [];

    // Get keyword data for all stored quarters
    const keywordData = {};
    
    for (const quarter of quarters) {
      const kvKey = `keywords:${quarter}`;
      const data = await kv.get(kvKey);
      
      if (data) {
        keywordData[quarter] = JSON.parse(data);
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
