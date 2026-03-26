// Save encrypted credentials to Upstash
// POST /api/save-credential
// Body: { key: "AMAZON_LWA_CLIENT_ID", encryptedValue: "..." }

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
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
    
    const { key, encryptedValue } = req.body;

    if (!key || !encryptedValue) {
      return res.status(400).json({ error: 'Missing key or encryptedValue' });
    }

    // Allowlist of credential keys
    const allowedKeys = [
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

    if (!allowedKeys.includes(key)) {
      return res.status(403).json({ error: 'Key not allowed' });
    }

    // Store in Upstash with user-specific key
    const kvKey = `credential:${userEmail}:${key}`;
    await kv.set(kvKey, encryptedValue);

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error saving credential:', error);
    res.status(500).json({ error: error.message });
  }
}
