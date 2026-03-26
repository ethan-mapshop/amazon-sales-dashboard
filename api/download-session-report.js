import SellingPartner from 'amazon-sp-api';
import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { reportId } = req.body;

    if (!reportId) {
      return res.status(400).json({ error: 'Report ID required' });
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

    // Check report status
    const statusResponse = await sellingPartner.callAPI({
      operation: 'getReport',
      endpoint: 'reports',
      path: {
        reportId
      }
    });

    if (statusResponse.processingStatus !== 'DONE') {
      return res.status(200).json({
        status: statusResponse.processingStatus,
        message: 'Report still processing'
      });
    }

    // Download report
    const reportDocument = await sellingPartner.download(statusResponse.reportDocumentId);
    
    // The download method returns the raw content - parse if it's a JSON string
    let reportData;
    if (typeof reportDocument === 'string') {
      reportData = JSON.parse(reportDocument);
    } else {
      reportData = reportDocument;
    }

    // Parse and store data
    const sessionData = parseSessionReport(reportData);
    
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

function parseSessionReport(reportData) {
  const data = [];
  
  // Amazon's report structure: salesAndTrafficByAsin array
  const records = reportData.salesAndTrafficByAsin || [];
  
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
