import SellingPartner from 'amazon-sp-api';

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

    const { startDate, endDate } = req.body;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Start and end dates required (YYYY-MM-DD format)' });
    }

    // Initialize SP-API client
    const sellingPartner = new SellingPartner({
      region: 'na',
      refresh_token: process.env.AMAZON_REFRESH_TOKEN,
      credentials: {
        SELLING_PARTNER_APP_CLIENT_ID: process.env.AMAZON_LWA_CLIENT_ID,
        SELLING_PARTNER_APP_CLIENT_SECRET: process.env.AMAZON_LWA_CLIENT_SECRET
      }
    });

    // Request report
    const reportResponse = await sellingPartner.callAPI({
      operation: 'createReport',
      endpoint: 'reports',
      body: {
        reportType: 'GET_SALES_AND_TRAFFIC_REPORT',
        marketplaceIds: [process.env.AMAZON_MARKETPLACE_ID],
        dataStartTime: `${startDate}T00:00:00Z`,
        dataEndTime: `${endDate}T23:59:59Z`,
        reportOptions: {
          asinGranularity: 'CHILD'
        }
      }
    });

    const reportId = reportResponse.reportId;

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
