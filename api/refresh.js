// Daily cron endpoint — called by Vercel at 10am UTC (vercel.json)
// Triggers the orders sync for yesterday's data

export default async function handler(req, res) {
  // Only allow GET (Vercel crons use GET)
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const results = {};

  // 1. Sync yesterday's orders
  try {
    const ordersRes = await fetch(`${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'http://localhost:3000'}/api/orders?action=sync`);
    results.orders = await ordersRes.json();
    console.log('[REFRESH] Orders sync:', results.orders);
  } catch (error) {
    console.error('[REFRESH] Orders sync failed:', error.message);
    results.orders = { success: false, error: error.message };
  }

  // 2. Sync yesterday's sessions (traffic data)
  try {
    const sessionsRes = await fetch(`${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'http://localhost:3000'}/api/sessions?action=sync`);
    results.sessions = await sessionsRes.json();
    console.log('[REFRESH] Sessions sync:', results.sessions);
  } catch (error) {
    console.error('[REFRESH] Sessions sync failed:', error.message);
    results.sessions = { success: false, error: error.message };
  }

  return res.status(200).json({
    success: true,
    timestamp: new Date().toISOString(),
    results
  });
}
