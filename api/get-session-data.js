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

    // Get session data from Upstash (KV returns deserialized objects)
    const sessionData = await kv.get('session_data');
    
    // Handle empty or missing data
    if (!sessionData) {
      return res.status(200).json({ 
        success: true,
        data: []
      });
    }

    return res.status(200).json({ 
      success: true,
      data: sessionData
    });

  } catch (error) {
    console.error('Error retrieving session data:', error);
    return res.status(500).json({ error: 'Failed to retrieve session data: ' + error.message });
  }
}
