import SellingPartner from 'amazon-sp-api';
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

    // Initialize SP-API client
    const sellingPartner = new SellingPartner({
      region: 'na',
      refresh_token: process.env.AMAZON_REFRESH_TOKEN,
      credentials: {
        SELLING_PARTNER_APP_CLIENT_ID: process.env.AMAZON_LWA_CLIENT_ID,
        SELLING_PARTNER_APP_CLIENT_SECRET: process.env.AMAZON_LWA_CLIENT_SECRET
      }
    });

    // Backfill from Jan 1, 2026 to March 24, 2026
    const startDate = new Date('2026-01-01');
    const endDate = new Date('2026-03-24');
    
    const allData = [];
    let processedDays = 0;
    let currentDate = new Date(startDate);

    // Stream progress updates
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    while (currentDate <= endDate) {
      const dateStr = currentDate.toISOString().split('T')[0];
      
      try {
        res.write(`data: Processing ${dateStr}...\n\n`);
        
        // Request report for this day
        const reportResponse = await sellingPartner.callAPI({
          operation: 'createReport',
          endpoint: 'reports',
          body: {
            reportType: 'GET_SALES_AND_TRAFFIC_REPORT',
            marketplaceIds: [process.env.AMAZON_MARKETPLACE_ID],
            dataStartTime: `${dateStr}T00:00:00Z`,
            dataEndTime: `${dateStr}T23:59:59Z`,
            reportOptions: {
              asinGranularity: 'CHILD'
            }
          }
        });

        const reportId = reportResponse.reportId;
        
        // Poll for completion (max 2 minutes)
        let attempts = 0;
        let statusResponse;
        
        while (attempts < 24) { // 24 * 5 seconds = 2 minutes
          await sleep(5000); // Wait 5 seconds between checks
          
          statusResponse = await sellingPartner.callAPI({
            operation: 'getReport',
            endpoint: 'reports',
            path: { reportId }
          });
          
          if (statusResponse.processingStatus === 'DONE') {
            break;
          }
          
          attempts++;
        }
        
        if (statusResponse.processingStatus !== 'DONE') {
          res.write(`data: Warning: ${dateStr} report timed out, skipping\n\n`);
          currentDate.setDate(currentDate.getDate() + 1);
          continue;
        }
        
        // Download and parse report
        const documentResponse = await sellingPartner.callAPI({
          operation: 'getReportDocument',
          endpoint: 'reports',
          path: { reportDocumentId: statusResponse.reportDocumentId }
        });
        
        const downloadResponse = await fetch(documentResponse.url);
        const buffer = Buffer.from(await downloadResponse.arrayBuffer());
        const { gunzipSync } = await import('zlib');
        const decompressed = gunzipSync(buffer);
        const reportData = JSON.parse(decompressed.toString());
        
        // Parse this day's data
        const dayData = parseSessionReport(reportData, dateStr);
        allData.push(...dayData);
        
        processedDays++;
        res.write(`data: Completed ${dateStr} (${processedDays} days processed)\n\n`);
        
        // Rate limiting: wait 2 seconds between requests
        await sleep(2000);
        
      } catch (error) {
        res.write(`data: Error processing ${dateStr}: ${error.message}\n\n`);
      }
      
      currentDate.setDate(currentDate.getDate() + 1);
    }
    
    // Store all data in Upstash
    await kv.set('session_data', allData);
    
    res.write(`data: COMPLETE - Stored ${allData.length} records from ${processedDays} days\n\n`);
    res.end();

  } catch (error) {
    console.error('Backfill error:', error);
    return res.status(500).json({ error: 'Backfill failed: ' + error.message });
  }
}

function parseSessionReport(reportData, date) {
  const data = [];
  const records = reportData.salesAndTrafficByAsin || [];
  
  records.forEach(record => {
    const asin = record.parentAsin;
    const traffic = record.trafficByAsin || {};
    
    data.push({
      date,
      asin,
      sessions: traffic.sessions || 0,
      sessionPercentage: traffic.sessionPercentage || 0,
      pageViews: traffic.pageViews || 0,
      unitSessionPercentage: traffic.unitSessionPercentage || 0,
      buyBoxPercentage: traffic.buyBoxPercentage || 0
    });
  });
  
  return data;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
