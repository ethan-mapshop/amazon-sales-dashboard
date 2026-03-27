import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  const { action } = req.query;

  if (!action) {
    return res.status(400).json({ error: 'Action parameter required' });
  }

  // Handle GET requests
  if (req.method === 'GET') {
    if (action === 'get') {
      return handleGet(req, res);
    } else if (action === 'vercel-status') {
      return handleVercelStatus(req, res);
    }
    return res.status(400).json({ error: 'Invalid action for GET' });
  }

  // Handle POST requests
  if (req.method === 'POST' && action === 'save') {
    return handleSave(req, res);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// SAVE: Save encrypted credential to Upstash
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

    const { key, encryptedValue } = req.body;

    if (!key || !encryptedValue) {
      return res.status(400).json({ error: 'Missing key or encryptedValue' });
    }

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

    const kvKey = `credential:${key}`;
    await kv.set(kvKey, encryptedValue);

    return res.status(200).json({ 
      success: true,
      message: `Credential ${key} saved successfully`
    });

  } catch (error) {
    console.error('Error saving credential:', error);
    return res.status(500).json({ error: 'Failed to save credential: ' + error.message });
  }
}

// GET: Retrieve all encrypted credentials
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
    
    for (const key of credentialKeys) {
      const kvKey = `credential:${key}`;
      const encryptedValue = await kv.get(kvKey);
      
      if (encryptedValue) {
        credentials[key] = encryptedValue;
      }
    }

    return res.status(200).json({ 
      success: true,
      credentials
    });

  } catch (error) {
    console.error('Error retrieving credentials:', error);
    return res.status(500).json({ error: 'Failed to retrieve credentials: ' + error.message });
  }
}

// VERCEL-STATUS: Check which credentials exist in Vercel env vars
async function handleVercelStatus(req, res) {
  try {
    const accessToken = req.headers.authorization?.replace('Bearer ', '');
    
    if (!accessToken) {
      return res.status(401).json({ error: 'No access token provided' });
    }

    const verifyResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
    
    if (!verifyResponse.ok) {
      return res.status(401).json({ error: 'Invalid access token' });
    }

    const vercelToken = process.env.VERCEL_TOKEN;
    const projectId = process.env.VERCEL_PROJECT_ID;

    if (!vercelToken || !projectId) {
      return res.status(500).json({ error: 'Vercel credentials not configured' });
    }

    const response = await fetch(
      `https://api.vercel.com/v9/projects/${projectId}/env`,
      {
        headers: {
          'Authorization': `Bearer ${vercelToken}`
        }
      }
    );

    if (!response.ok) {
      throw new Error('Failed to fetch Vercel env vars');
    }

    const data = await response.json();
    const envVars = data.envs || [];
    
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

    const status = {};
    credentialKeys.forEach(key => {
      status[key] = envVars.some(env => env.key === key);
    });

    return res.status(200).json({ 
      success: true,
      status
    });

  } catch (error) {
    console.error('Error checking Vercel status:', error);
    return res.status(500).json({ error: 'Failed to check Vercel status: ' + error.message });
  }
}
