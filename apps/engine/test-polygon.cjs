const axios = require('axios');
require('dotenv').config();

async function test() {
  const key = process.env.POLYGON_API_KEY;
  if (!key) {
    console.error("No POLYGON_API_KEY");
    return;
  }
  
  const now = Date.now();
  const minute = Math.floor(now / 60000) * 60000;
  const from = minute - 5 * 60000;
  const to = minute + 60000;
  
  for (const ticker of ["I:VIX", "I:TICK"]) {
    const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/minute/${from}/${to}?adjusted=true&sort=desc&limit=20&apiKey=${key}`;
    try {
      console.log(`Testing ${ticker}...`);
      const res = await axios.get(url);
      console.log(`${ticker} success:`, res.data);
    } catch (err) {
      console.error(`${ticker} error:`, err.response?.status, err.response?.data || err.message);
    }
  }
}
test();
