// API endpoint to serve cached data from Vercel KV
// GET /api/data?type=transactions&startDate=2025-01&endDate=2025-12

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  // Handle OPTIONS request
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { type, startDate, endDate } = req.query;

    if (!type) {
      return res.status(400).json({ error: 'Missing required parameter: type' });
    }

    // Map type to KV key prefix
    const keyPrefix = getKeyPrefix(type);
    if (!keyPrefix) {
      return res.status(400).json({ error: `Invalid type: ${type}` });
    }

    // If no date range specified, return all data
    if (!startDate || !endDate) {
      const allData = await getAllData(keyPrefix);
      return res.status(200).json(allData);
    }

    // Get data for date range
    const data = await getDataByDateRange(keyPrefix, startDate, endDate);
    
    res.status(200).json(data);

  } catch (error) {
    console.error('Error fetching data:', error);
    res.status(500).json({ 
      error: 'Failed to fetch data', 
      message: error.message 
    });
  }
}

// Map data type to KV key prefix
function getKeyPrefix(type) {
  const mapping = {
    'transactions': 'transactions',
    'shipping': 'shipping',
    'productads': 'productads',
    'brandads': 'brandads'
  };
  return mapping[type.toLowerCase()];
}

// Get all data for a type (no date filtering)
async function getAllData(keyPrefix) {
  try {
    // Get all keys with this prefix
    const keys = await kv.keys(`${keyPrefix}:*`);
    
    if (!keys || keys.length === 0) {
      return { headers: [], rows: [] };
    }

    // Fetch all months
    const promises = keys.map(key => kv.get(key));
    const results = await Promise.all(promises);

    // Combine all months
    let allHeaders = [];
    let allRows = [];

    results.forEach(result => {
      if (result) {
        const parsed = typeof result === 'string' ? JSON.parse(result) : result;
        if (!allHeaders.length && parsed.headers) {
          allHeaders = parsed.headers;
        }
        if (parsed.rows) {
          allRows = allRows.concat(parsed.rows);
        }
      }
    });

    return { headers: allHeaders, rows: allRows };

  } catch (error) {
    console.error(`Error getting all data for ${keyPrefix}:`, error);
    return { headers: [], rows: [] };
  }
}

// Get data for specific date range
async function getDataByDateRange(keyPrefix, startDate, endDate) {
  try {
    // Generate list of months to fetch (YYYY-MM format)
    const months = getMonthsBetween(startDate, endDate);
    
    // Fetch data for each month
    const promises = months.map(month => kv.get(`${keyPrefix}:${month}`));
    const results = await Promise.all(promises);

    // Combine results
    let allHeaders = [];
    let allRows = [];

    results.forEach(result => {
      if (result) {
        const parsed = typeof result === 'string' ? JSON.parse(result) : result;
        if (!allHeaders.length && parsed.headers) {
          allHeaders = parsed.headers;
        }
        if (parsed.rows) {
          allRows = allRows.concat(parsed.rows);
        }
      }
    });

    // Filter rows by exact date range (in case month boundaries don't align)
    const dateIdx = allHeaders.findIndex(h => h && h.toLowerCase().includes('date'));
    if (dateIdx !== -1) {
      allRows = allRows.filter(row => {
        const rowDate = row[dateIdx];
        return rowDate >= startDate && rowDate <= endDate;
      });
    }

    return { headers: allHeaders, rows: allRows };

  } catch (error) {
    console.error(`Error getting data by date range for ${keyPrefix}:`, error);
    return { headers: [], rows: [] };
  }
}

// Generate array of YYYY-MM strings between two dates
function getMonthsBetween(startDate, endDate) {
  const months = [];
  const start = new Date(startDate);
  const end = new Date(endDate);

  let current = new Date(start.getFullYear(), start.getMonth(), 1);
  const endMonth = new Date(end.getFullYear(), end.getMonth(), 1);

  while (current <= endMonth) {
    const year = current.getFullYear();
    const month = String(current.getMonth() + 1).padStart(2, '0');
    months.push(`${year}-${month}`);
    current.setMonth(current.getMonth() + 1);
  }

  return months;
}
