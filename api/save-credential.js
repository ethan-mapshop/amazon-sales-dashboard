// Save credential endpoint - updates Vercel environment variables
// POST /api/save-credential
// Headers: Authorization: Bearer <google-token>
// Body: { key: "AMAZON_LWA_CLIENT_ID", value: "..." }

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify Google token from Authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized - No token provided' });
  }

  const token = authHeader.substring(7);
  
  // Verify token with Google
  try {
    const verifyResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${token}`);
    if (!verifyResponse.ok) {
      return res.status(401).json({ error: 'Unauthorized - Invalid token' });
    }
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized - Token verification failed' });
  }

  const { key, value } = req.body;

  if (!key || !value) {
    return res.status(400).json({ error: 'Missing key or value' });
  }

  // Allowlist of updatable keys - never allow arbitrary env var writes
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

  // Check if required Vercel env vars are set
  if (!process.env.VERCEL_TOKEN || !process.env.VERCEL_PROJECT_ID) {
    return res.status(500).json({ 
      error: 'Server not configured',
      message: 'VERCEL_TOKEN and VERCEL_PROJECT_ID environment variables must be set'
    });
  }

  try {
    // Update via Vercel API
    const response = await fetch(
      `https://api.vercel.com/v10/projects/${process.env.VERCEL_PROJECT_ID}/env`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.VERCEL_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          key,
          value,
          type: 'encrypted',
          target: ['production']
        })
      }
    );

    if (!response.ok) {
      const error = await response.text();
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to update environment variable',
        details: error
      });
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error saving credential:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}
