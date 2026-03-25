// Get encrypted credentials from Upstash
// GET /api/get-credentials-upstash
// Returns: { credentials: { AMAZON_LWA_CLIENT_ID: "encrypted...", ... } }

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify Google token
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.substring(7);
  
  try {
    const verifyResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${token}`);
    if (!verifyResponse.ok) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const tokenInfo = await verifyResponse.json();
    const userEmail = tokenInfo.email;
    
    if (!userEmail) {
      return res.status(401).json({ error: 'No email in token' });
    }

    // List of credential keys to fetch
    const credentialKeys = [
      'AMAZON_LWA_CLIENT_ID',
      'AMAZON_LWA_CLIENT_SECRET',
      'AMAZON_REFRESH_TOKEN',
      'AMAZON_SELLER_ID',
      'AMAZON_MARKETPLACE_ID',
      'ADV_CLIENT_ID',
      'ADV_CLIENT_SECRET',
      'ADV_REFRESH_TOKEN',
      'ADV_PROFILE_ID',
      'SHIPSTATION_API_KEY',
      'SHIPSTATION_API_SECRET',
      'ANTHROPIC_API_KEY',
      'GOOGLE_CLIENT_ID'
    ];

    const credentials = {};
    
    // Fetch each credential from Upstash
    for (const key of credentialKeys) {
      const kvKey = `credential:${userEmail}:${key}`;
      const encryptedValue = await kv.get(kvKey);
      
      // Only include if value exists
      if (encryptedValue) {
        credentials[key] = encryptedValue;
      }
    }

    res.status(200).json({ credentials });
  } catch (error) {
    console.error('Error fetching credentials:', error);
    res.status(500).json({ error: error.message });
  }
}
