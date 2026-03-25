// Get credential status - checks which env vars are set
// GET /api/get-credentials
// Returns: { AMAZON_LWA_CLIENT_ID: true, AMAZON_LWA_CLIENT_SECRET: false, ... }

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
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Check if Vercel credentials are configured
  if (!process.env.VERCEL_TOKEN || !process.env.VERCEL_PROJECT_ID) {
    return res.status(500).json({ error: 'Server not configured' });
  }

  try {
    // Fetch all env vars from Vercel
    const response = await fetch(
      `https://api.vercel.com/v9/projects/${process.env.VERCEL_PROJECT_ID}/env`,
      {
        headers: {
          Authorization: `Bearer ${process.env.VERCEL_TOKEN}`
        }
      }
    );

    if (!response.ok) {
      return res.status(500).json({ error: 'Failed to fetch credentials' });
    }

    const { envs } = await response.json();

    // Build status object for each credential we care about
    const credentials = {
      AMAZON_LWA_CLIENT_ID: false,
      AMAZON_LWA_CLIENT_SECRET: false,
      AMAZON_REFRESH_TOKEN: false,
      AMAZON_SELLER_ID: false,
      AMAZON_MARKETPLACE_ID: false,
      ADV_CLIENT_ID: false,
      ADV_CLIENT_SECRET: false,
      ADV_REFRESH_TOKEN: false,
      ADV_PROFILE_ID: false,
      SHIPSTATION_API_KEY: false,
      SHIPSTATION_API_SECRET: false,
      ANTHROPIC_API_KEY: false,
      GOOGLE_CLIENT_ID: false
    };

    // Mark which ones exist (for production target)
    envs.forEach(env => {
      if (env.target.includes('production') && credentials.hasOwnProperty(env.key)) {
        credentials[env.key] = true;
      }
    });

    res.status(200).json({ credentials });
  } catch (error) {
    console.error('Error fetching credentials:', error);
    res.status(500).json({ error: error.message });
  }
}
