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

    const { reportId } = req.body;

    if (!reportId) {
      return res.status(400).json({ error: 'Report ID required' });
    }

    // Get credentials from Vercel environment variables
    const clientId = process.env.AMAZON_LWA_CLIENT_ID;
    const clientSecret = process.env.AMAZON_LWA_CLIENT_SECRET;
    const refreshToken = process.env.AMAZON_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !refreshToken) {
      return res.status(400).json({ error: 'Amazon SP-API credentials not configured in Vercel environment variables' });
    }

    // Get access token
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

    // Check report status
    const statusResponse = await fetch(`https://sellingpartnerapi-na.amazon.com/reports/2021-06-30/reports/${reportId}`, {
      headers: {
        'x-amz-access-token': spAccessToken
      }
    });

    if (!statusResponse.ok) {
      throw new Error('Failed to check report status');
    }

    const statusData = await statusResponse.json();

    if (statusData.processingStatus !== 'DONE') {
      return res.status(200).json({
        status: statusData.processingStatus,
        message: 'Report still processing'
      });
    }

    // Get report document
    const documentId = statusData.reportDocumentId;
    const docResponse = await fetch(`https://sellingpartnerapi-na.amazon.com/reports/2021-06-30/documents/${documentId}`, {
      headers: {
        'x-amz-access-token': spAccessToken
      }
    });

    if (!docResponse.ok) {
      throw new Error('Failed to get report document info');
    }

    const docData = await docResponse.json();
    const reportUrl = docData.url;

    // Download report
    const reportResponse = await fetch(reportUrl);
    if (!reportResponse.ok) {
      throw new Error('Failed to download report');
    }

    const reportJson = await reportResponse.json();

    // Parse and store data
    const sessionData = parseSessionReport(reportJson);
    
    // Store in Upstash
    await kv.set('session_data', JSON.stringify(sessionData));

    return res.status(200).json({
      status: 'DONE',
      success: true,
      recordCount: sessionData.length,
      message: 'Report downloaded and stored successfully'
    });

  } catch (error) {
    console.error('Error downloading session report:', error);
    return res.status(500).json({ error: 'Failed to download report: ' + error.message });
  }
}

function parseSessionReport(reportJson) {
  const data = [];
  
  // Amazon's report structure: salesAndTrafficByAsin array
  const records = reportJson.salesAndTrafficByAsin || [];
  
  records.forEach(record => {
    const asin = record.childAsin;
    const trafficByDate = record.trafficByDate || {};
    
    Object.keys(trafficByDate).forEach(date => {
      const traffic = trafficByDate[date];
      
      data.push({
        date,
        asin,
        sessions: traffic.browserSessions || 0,
        sessionPercentage: traffic.browserSessionPercentage || 0,
        pageViews: traffic.browserPageViews || 0,
        unitSessionPercentage: traffic.unitSessionPercentage || 0, // This is CVR
        buyBoxPercentage: traffic.buyBoxPercentage || 0
      });
    });
  });
  
  return data;
}
