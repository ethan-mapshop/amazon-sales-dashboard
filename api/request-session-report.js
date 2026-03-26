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

    // Get Amazon credentials from Upstash
    const clientId = await kv.get('credential:AMAZON_LWA_CLIENT_ID');
    const clientSecret = await kv.get('credential:AMAZON_LWA_CLIENT_SECRET');
    const refreshToken = await kv.get('credential:AMAZON_REFRESH_TOKEN');
    const marketplaceId = await kv.get('credential:AMAZON_MARKETPLACE_ID');

    if (!clientId || !clientSecret || !refreshToken || !marketplaceId) {
      return res.status(400).json({ error: 'Amazon SP-API credentials not configured' });
    }

    const { startDate, endDate } = req.body;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Start and end dates required (YYYY-MM-DD format)' });
    }

    // Step 1: Get access token
    const tokenResponse = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret
      })
    });

    if (!tokenResponse.ok) {
      throw new Error('Failed to get Amazon access token');
    }

    const tokenData = await tokenResponse.json();
    const spAccessToken = tokenData.access_token;

    // Step 2: Request report
    const reportResponse = await fetch('https://sellingpartnerapi-na.amazon.com/reports/2021-06-30/reports', {
      method: 'POST',
      headers: {
        'x-amz-access-token': spAccessToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        reportType: 'GET_SALES_AND_TRAFFIC_REPORT',
        marketplaceIds: [marketplaceId],
        dataStartTime: `${startDate}T00:00:00Z`,
        dataEndTime: `${endDate}T23:59:59Z`,
        reportOptions: {
          asinGranularity: 'CHILD'
        }
      })
    });

    if (!reportResponse.ok) {
      const errorData = await reportResponse.text();
      throw new Error(`Report request failed: ${errorData}`);
    }

    const reportData = await reportResponse.json();
    const reportId = reportData.reportId;

    // Return report ID for polling
    return res.status(200).json({
      success: true,
      reportId,
      message: 'Report requested. Use report ID to check status.'
    });

  } catch (error) {
    console.error('Error requesting session report:', error);
    return res.status(500).json({ error: 'Failed to request report: ' + error.message });
  }
}
