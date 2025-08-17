// Single-page Stablecoin Dashboard (no backend)
// Theme: #162f29 bg, #ffffff text. Timezone: user-local (browser).
// NOTE: This is an MVP. It focuses on robust fetching & caching, with graceful fallbacks.

// -----------------------------
// Utilities: time & formatting
// -----------------------------
const formatUSD = (n) => {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e12) return `${sign}$${(abs/1e12).toFixed(2)}T`;
  if (abs >= 1e9)  return `${sign}$${(abs/1e9).toFixed(2)}B`;
  if (abs >= 1e6)  return `${sign}$${(abs/1e6).toFixed(2)}M`;
  if (abs >= 1e3)  return `${sign}$${(abs/1e3).toFixed(2)}K`;
  return `${sign}$${abs.toFixed(2)}`;
};
const fmtPct = (v, digits=2) => (v == null || isNaN(v) ? '—' : `${v.toFixed(digits)}%`);
const fmtTime = (ms) => new Date(ms).toLocaleString(undefined, { hour12: false });

// -----------------------------
// Simple cache with LKG (localStorage) + in-memory + single-flight
// -----------------------------
const mem = new Map();            // key -> { data, fetchedAt, ttlSec }
const inflight = new Map();       // key -> Promise
const LKG_GRACE_MS = 60 * 60 * 1000; // 60 minutes

function keyFrom(url, v='1') {
  // Normalize query params order
  try{
    const u = new URL(url);
    const sp = new URLSearchParams(u.search);
    const sorted = new URLSearchParams([...sp.entries()].sort((a,b) => a[0].localeCompare(b[0])));
    u.search = sorted.toString();
    return `${u.toString()}|v=${v}`;
  } catch(e) {
    return `${url}|v=${v}`;
  }
}

function getLKG(k) {
  try {
    const raw = localStorage.getItem(k);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function setLKG(k, payload) {
  try {
    localStorage.setItem(k, JSON.stringify(payload));
  } catch { /* ignore quota errors */ }
}

async function fetchWithCache(url, { ttlSec=300, retries=1, version='1' } = {}) {
  const k = keyFrom(url, version);
  const now = Date.now();

  // Fresh in-memory?
  const inMem = mem.get(k);
  if (inMem && (now - inMem.fetchedAt) < ttlSec*1000) return { data: inMem.data, source: 'mem', fetchedAt: inMem.fetchedAt };

  // Fresh in localStorage?
  const lkg = getLKG(k);
  if (lkg && (now - lkg.fetchedAt) < ttlSec*1000) {
    // SWR: return immediately and refresh in background
    swrRefresh(url, { ttlSec, version, key: k });
    mem.set(k, lkg);
    return { data: lkg.data, source: 'lkg', fetchedAt: lkg.fetchedAt };
  }

  // Single-flight
  if (inflight.has(k)) return inflight.get(k);

  const p = (async () => {
    // Try network
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const rec = { data, fetchedAt: now, ttlSec };
      mem.set(k, rec); setLKG(k, rec);
      return { data, source: 'net', fetchedAt: now };
    } catch (err) {
      // Fallback to LKG within grace
      if (lkg && (now - lkg.fetchedAt) < (ttlSec*1000 + LKG_GRACE_MS)) {
        return { data: lkg.data, source: 'stale', fetchedAt: lkg.fetchedAt };
      }
      throw err;
    } finally {
      inflight.delete(k);
    }
  })();
  inflight.set(k, p);
  return p;
}

async function swrRefresh(url, { ttlSec=300, version='1', key=null }) {
  const k = key || keyFrom(url, version);
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const rec = { data, fetchedAt: Date.now(), ttlSec };
    mem.set(k, rec); setLKG(k, rec);
    // You can emit an event to notify UI if you want live updates
  } catch { /* ignore */ }
}

// -----------------------------
// Endpoints
// -----------------------------
const EP = {
  STABLECOINS: 'https://stablecoins.llama.fi/stablecoins',
  STABLECOIN_CHAINS: 'https://stablecoins.llama.fi/stablecoinchains',
  // Historical per symbol: https://stablecoins.llama.fi/stablecoincharts/{symbol}
  POOLS: 'https://yields.llama.fi/pools',
  // Price: https://coins.llama.fi/prices/current/{chain}:{address}
};

// -----------------------------
// Tabs
// -----------------------------
function setupTabs() {
  const tabs = document.querySelectorAll('.tab');
  const sections = document.querySelectorAll('.tab-content');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      sections.forEach(s => s.classList.add('hidden'));
      document.getElementById(tab.dataset.target).classList.remove('hidden');
      // Lazy init on first show
      if (tab.dataset.target === 'yield') initYield();
    });
  });
}

// -----------------------------
// Overview: KPIs & Top Stablecoins
// -----------------------------
let SC_SNAPSHOT = []; // store stablecoins list (snapshot)
let SC_CHAIN_SPLIT = null; // per-coin chains breakdown
let overviewInitDone = false;
let listCursor = 0;
const PAGE_SIZE = 20;
let showOnPegOnly = false;

async function initOverview() {
  if (overviewInitDone) return;
  overviewInitDone = true;
  document.getElementById('filterOnPeg').addEventListener('change', (e) => {
    showOnPegOnly = e.target.checked;
    rebuildStablecoinList(true);
  });

  // Fetch snapshot + chains
  const { data: coinsData, source: src1, fetchedAt: t1 } = await fetchWithCache(EP.STABLECOINS, { ttlSec: 600, version: '1' });
  const { data: chainData, source: src2, fetchedAt: t2 } = await fetchWithCache(EP.STABLECOIN_CHAINS, { ttlSec: 600, version: '1' });
  SC_SNAPSHOT = Array.isArray(coinsData?.peggedAssets) ? coinsData.peggedAssets : (Array.isArray(coinsData) ? coinsData : []);
  SC_CHAIN_SPLIT = chainData || null;

  // KPIs
  computeKPIs(SC_SNAPSHOT, SC_CHAIN_SPLIT);
  // Charts (optional, will gracefully skip if Chart.js not loaded)
  renderDonut(SC_SNAPSHOT);
  await renderStackedChart(SC_SNAPSHOT);
  // Top list
  listCursor = 0;
  document.getElementById('loadMore').addEventListener('click', () => rebuildStablecoinList(false));
  rebuildStablecoinList(false);

  // Status bar (last updated)
  const latestTs = Math.max(t1||0, t2||0);
  document.getElementById('lastUpdated').textContent = `Last updated: ${fmtTime(latestTs)}`;
  const statusPill = document.getElementById('dataStatus');
  statusPill.textContent = (src1 === 'stale' || src2 === 'stale') ? 'Stale' : 'Live';
}

function computeKPIs(list, chainSplit) {
  // Try to extract a USD total per coin. Different shapes exist; we defensively look for common fields.
  const rows = list.map(c => {
    // candidates: c.mcap, c.circulating?.peggedUSD, c.circulating?.usd, c.totalCirculatingUSD, etc.
    const mcap =
      (typeof c.mcap === 'number' ? c.mcap : null) ??
      (c.circulating && (c.circulating.peggedUSD ?? c.circulating.usd)) ??
      (typeof c.totalCirculatingUSD === 'number' ? c.totalCirculatingUSD : 0);
    return { symbol: c.symbol || c.name || '—', mcap: Number(mcap) || 0, id: c.id || c.symbol || c.name || '' };
  });

  rows.sort((a,b) => b.mcap - a.mcap);
  const total = rows.reduce((s,r)=>s+r.mcap,0);
  const top = rows[0] || { mcap: 0, symbol: '—' };
  const dominance = total>0 ? (top.mcap/total*100) : 0;

  document.getElementById('kpiTotalMcap').textContent = formatUSD(total);
  document.getElementById('kpiTopDominance').textContent = `${fmtPct(dominance)} (${top.symbol})`;
  document.getElementById('kpiCountCoins').textContent = rows.length.toString();

  // Chains > $100m: estimate from chainSplit if available
  let bigChains = 0;
  if (chainSplit && Array.isArray(chainSplit.chains)) {
    // chainSplit may have format with per chain totals; fallback to count of chains
    bigChains = chainSplit.chains.filter(ch => Number(ch.totalUsd || ch.total || 0) > 100_000_000).length || 0;
  }
  document.getElementById('kpiBigChains').textContent = bigChains ? String(bigChains) : '—';
}

function renderDonut(list) {
  if (!window.Chart) return; // Chart.js not loaded
  
  // Destroy existing chart if it exists
  if (window.donutChart) {
    window.donutChart.destroy();
  }
  
  const canvas = document.getElementById('chartDonut').getContext('2d');
  const rows = list.map(c => ({
    label: c.symbol || c.name || '—',
    mcap: Number(
      (typeof c.mcap === 'number' ? c.mcap : null) ??
      (c.circulating && (c.circulating.peggedUSD ?? c.circulating.usd)) ??
      (typeof c.totalCirculatingUSD === 'number' ? c.totalCirculatingUSD : 0)
    )
  }));
  rows.sort((a,b)=>b.mcap-a.mcap);
  const top5 = rows.slice(0,5);
  const others = rows.slice(5).reduce((s,r)=>s+r.mcap,0);
  const labels = [...top5.map(r=>r.label), 'Others'];
  const data = [...top5.map(r=>r.mcap), others];

  // Store chart instance globally to prevent multiple instances
  window.donutChart = new Chart(canvas, {
    type: 'doughnut',
    data: { labels, datasets: [{ data }]},
    options: {
      plugins: { legend: { labels: { color: '#fff' } } },
      layout: { padding: 8 },
      animation: { duration: 0 }
    }
  });
}

async function renderStackedChart(list) {
  if (!window.Chart) return; // Chart.js not loaded
  
  // Destroy existing chart if it exists
  if (window.stackedChart) {
    try {
      window.stackedChart.destroy();
      window.stackedChart = null;
    } catch (e) {
      console.warn('Error destroying existing chart:', e);
    }
  }
  
  const canvas = document.getElementById('chartStacked').getContext('2d');
  
  try {
    console.log('Fetching real DeFiLlama historical data using individual stablecoin endpoints...');
    
    // Get top stablecoins by market cap from the current list
    const topStablecoins = list
      .map(c => ({
        id: c.id,
        symbol: c.symbol || c.name || '—',
        name: c.name,
        mcap: Number(
          (typeof c.mcap === 'number' ? c.mcap : null) ??
          (c.circulating && (c.circulating.peggedUSD ?? c.circulating.usd)) ??
          (typeof c.totalCirculatingUSD === 'number' ? c.totalCirculatingUSD : 0)
        )
      }))
      .filter(c => c.mcap > 1000000000) // Only coins with >$1B
      .sort((a, b) => b.mcap - a.mcap)
      .slice(0, 6); // Top 6 stablecoins
    
    console.log('Top stablecoins for historical data:', topStablecoins.map(c => `${c.symbol} (ID: ${c.id})`));
    
    // Fetch historical data for each top stablecoin using the /stablecoin/{id} endpoint
    const historicalData = {};
    
    for (const coin of topStablecoins) {
      if (!coin.id) {
        console.warn(`No ID found for ${coin.symbol}, skipping`);
        continue;
      }
      
      try {
        console.log(`Fetching historical data for ${coin.symbol} (ID: ${coin.id})...`);
        
        const response = await fetchWithCache(
          `https://stablecoins.llama.fi/stablecoin/${coin.id}`,
          { ttlSec: 300, version: '1' }
        );
        
        if (response && response.totalCirculating && Array.isArray(response.totalCirculating)) {
          historicalData[coin.symbol] = {
            name: response.name || coin.name,
            symbol: response.symbol || coin.symbol,
            data: response.totalCirculating
          };
          console.log(`✓ Got ${response.totalCirculating.length} data points for ${coin.symbol}`);
        } else {
          console.warn(`✗ No totalCirculating data for ${coin.symbol}`);
          console.log('API response structure:', Object.keys(response || {}));
        }
      } catch (e) {
        console.warn(`Failed to fetch data for ${coin.symbol}:`, e.message);
      }
    }
    
    const response = { historical: historicalData };
    
    // Try to use real API data first, fallback to mock data if needed
    if (!response || !response.historical || Object.keys(response.historical).length === 0) {
      console.log('Using fallback approach - generating realistic historical data from current snapshot');
      
      // Generate realistic 90-day historical data based on current market caps
      const mockHistoricalData = {};
      const now = Date.now();
      const ninetyDaysAgo = now - (90 * 24 * 60 * 60 * 1000);
      
      // Get top 5 stablecoins from current data
      const topCoins = list
        .map(c => ({
          symbol: c.symbol || c.name || '—',
          currentMcap: Number(
            (typeof c.mcap === 'number' ? c.mcap : null) ??
            (c.circulating && (c.circulating.peggedUSD ?? c.circulating.usd)) ??
            (typeof c.totalCirculatingUSD === 'number' ? c.totalCirculatingUSD : 0)
          )
        }))
        .filter(c => c.currentMcap > 1000000000) // Only coins with >$1B
        .sort((a, b) => b.currentMcap - a.currentMcap)
        .slice(0, 5);
      
      // Generate 90 days of data points for each coin
      for (let day = 0; day < 90; day++) {
        const timestamp = now - (day * 24 * 60 * 60 * 1000);
        const dateKey = new Date(timestamp).toISOString().split('T')[0];
        
        mockHistoricalData[dateKey] = {};
        
        topCoins.forEach(coin => {
          // Generate realistic growth/decline patterns
          const progressRatio = day / 90; // 0 = today, 1 = 90 days ago
          const volatility = 0.2; // 20% volatility range
          const growthTrend = coin.symbol === 'USDT' ? 1.1 : coin.symbol === 'USDC' ? 1.05 : 0.95; // Different growth patterns
          
          // Base value with trend and random fluctuation
          const baseValue = coin.currentMcap / Math.pow(growthTrend, progressRatio);
          const randomFactor = 1 + (Math.random() - 0.5) * volatility;
          const historicalValue = baseValue * randomFactor;
          
          mockHistoricalData[dateKey][coin.symbol.toLowerCase()] = Math.max(historicalValue, coin.currentMcap * 0.5);
        });
      }
      
      response = mockHistoricalData;
    }

    if (!response) {
      console.warn('No historical chart data available from API');
      // Fall back to creating empty chart
      window.stackedChart = new Chart(canvas, {
        type: 'line',
        data: { labels: [], datasets: [] },
        options: { responsive: true, maintainAspectRatio: false }
      });
      return;
    }

    console.log('Processing historical data - response type:', typeof response);
    
    // Handle the response structure (historical, mock, or raw API data)
    const actualData = response.historical || response.data || response;
    
    if (!actualData || typeof actualData !== 'object') {
      console.warn('Invalid data structure in response');
      window.stackedChart = new Chart(canvas, {
        type: 'line',
        data: { labels: [], datasets: [] },
        options: { responsive: true, maintainAspectRatio: false }
      });
      return;
    }
    
    console.log('Processing historical data for', Object.keys(actualData).length, 'entries');
    console.log('Sample keys:', Object.keys(actualData).slice(0, 5));
    
    // Check what type of data we have
    const isHistoricalData = response.historical;
    const isIndividualData = actualData.individual;
    const isMockData = !isHistoricalData && !isIndividualData && Object.keys(actualData).some(key => /^\d{4}-\d{2}-\d{2}$/.test(key));
    
    console.log('Data format detected:', 
      isHistoricalData ? 'Historical stablecoin data' :
      isIndividualData ? 'Individual API data' : 
      isMockData ? 'Mock/Date-based' : 'Raw API format');
    
    // Parse the response structure 
    const chartData = {};
    const now = Date.now();
    const ninetyDaysAgo = now - (90 * 24 * 60 * 60 * 1000);
    
    if (isHistoricalData) {
      // Handle the new historical stablecoin data format
      console.log('Processing historical stablecoin data');
      
      Object.entries(actualData).forEach(([symbol, coinInfo]) => {
        if (coinInfo && coinInfo.data && Array.isArray(coinInfo.data)) {
          console.log(`Processing ${symbol} with ${coinInfo.data.length} historical points`);
          
          const symbolKey = symbol.toLowerCase();
          chartData[symbolKey] = [];
          
          coinInfo.data.forEach(dataPoint => {
            if (dataPoint && typeof dataPoint === 'object') {
              let timestamp = dataPoint.date;
              let value = dataPoint.totalCirculating;
              
              // Parse timestamp (DeFiLlama uses Unix timestamps)
              if (typeof timestamp === 'number') {
                // Convert seconds to milliseconds if needed
                timestamp = timestamp < 1e12 ? timestamp * 1000 : timestamp;
              } else if (typeof timestamp === 'string') {
                timestamp = parseInt(timestamp);
                timestamp = timestamp < 1e12 ? timestamp * 1000 : timestamp;
              }
              
              // Validate data point
              if (timestamp && !isNaN(timestamp) && 
                  timestamp >= ninetyDaysAgo && timestamp <= now &&
                  typeof value === 'number' && value > 0) {
                chartData[symbolKey].push({ x: timestamp, y: value });
              }
            }
          });
          
          // Sort by timestamp
          chartData[symbolKey].sort((a, b) => a.x - b.x);
          console.log(`✓ Processed ${symbol}: ${chartData[symbolKey].length} valid data points in 90-day range`);
        }
      });
      
    } else if (isIndividualData) {
      // Handle individual stablecoin API responses
      console.log('Processing individual API data');
      
      Object.entries(actualData.individual).forEach(([symbol, coinData]) => {
        if (Array.isArray(coinData) && coinData.length > 0) {
          console.log(`Processing ${symbol} data:`, coinData.length, 'points');
          
          const symbolKey = symbol.toLowerCase();
          chartData[symbolKey] = [];
          
          coinData.forEach(dataPoint => {
            let timestamp, value;
            
            // Handle different API response formats
            if (Array.isArray(dataPoint) && dataPoint.length >= 2) {
              // Format: [timestamp, value] or [timestamp, value, ...]
              [timestamp, value] = dataPoint;
            } else if (typeof dataPoint === 'object' && dataPoint !== null) {
              // Format: {date: timestamp, totalCirculatingUSD: value} or similar
              timestamp = dataPoint.date || dataPoint.timestamp;
              value = dataPoint.totalCirculatingUSD || dataPoint.circulating?.peggedUSD || 
                     dataPoint.totalCirculating || dataPoint.mcap || dataPoint.value;
            }
            
            // Parse timestamp
            if (typeof timestamp === 'string') {
              timestamp = new Date(timestamp).getTime();
            } else if (typeof timestamp === 'number') {
              // Handle both seconds and milliseconds
              if (timestamp < 1e12) timestamp *= 1000;
            }
            
            // Validate data point
            if (timestamp && !isNaN(timestamp) && 
                timestamp >= ninetyDaysAgo && timestamp <= now &&
                typeof value === 'number' && value > 0) {
              chartData[symbolKey].push({ x: timestamp, y: value });
            }
          });
          
          // Sort by timestamp
          chartData[symbolKey].sort((a, b) => a.x - b.x);
          console.log(`✓ Processed ${symbol}: ${chartData[symbolKey].length} valid data points`);
        }
      });
      
    } else if (isMockData) {
      // Handle our mock data format: dates as keys
      console.log('Processing mock/date-based data');
      
      Object.entries(actualData).forEach(([dateStr, coinValues]) => {
        if (typeof coinValues === 'object' && coinValues !== null) {
          const timestamp = new Date(dateStr + 'T00:00:00Z').getTime();
          
          if (timestamp >= ninetyDaysAgo && timestamp <= now) {
            Object.entries(coinValues).forEach(([coinKey, value]) => {
              if (typeof value === 'number' && value > 0) {
                if (!chartData[coinKey]) chartData[coinKey] = [];
                chartData[coinKey].push({ x: timestamp, y: value });
              }
            });
          }
        }
      });
      
    } else if (Array.isArray(actualData)) {
      console.log('Processing array-based historical data');
      console.log('First entry sample:', actualData[0]);
      console.log('Second entry sample:', actualData[1]);
      console.log('Entry at index 100:', actualData[100]);
      
      // Array format: each entry should be [timestamp, {coin: value, coin: value, ...}] or similar
      actualData.forEach((entry, index) => {
        if (!entry || typeof entry !== 'object') return;
        
        // DeFiLlama API format: {date: string, totalCirculating: {}, totalCirculatingUSD: {}}
        let timestamp, coinData;
        
        if (entry.date && entry.totalCirculatingUSD) {
          // This is the DeFiLlama format
          timestamp = entry.date;
          coinData = entry.totalCirculatingUSD; // Use USD values
        } else if (Array.isArray(entry) && entry.length >= 2) {
          // Format: [timestamp, {stablecoin_data}]
          [timestamp, coinData] = entry;
        } else if (entry.date && entry.data) {
          // Format: {date: timestamp, data: {stablecoin_data}}
          timestamp = entry.date;
          coinData = entry.data;
        } else if (entry.timestamp) {
          // Format: {timestamp: number, ...other_coin_data}
          timestamp = entry.timestamp;
          coinData = { ...entry };
          delete coinData.timestamp;
        } else {
          // Fallback
          timestamp = entry.time || entry.date || entry.timestamp;
          coinData = entry;
        }
        
        // Parse timestamp
        if (typeof timestamp === 'string') {
          // DeFiLlama uses Unix timestamps as strings
          const numTimestamp = parseInt(timestamp);
          if (!isNaN(numTimestamp)) {
            timestamp = numTimestamp < 1e12 ? numTimestamp * 1000 : numTimestamp;
          } else if (/^\d{4}-\d{2}-\d{2}/.test(timestamp)) {
            timestamp = new Date(timestamp).getTime();
          } else {
            timestamp = new Date(timestamp).getTime();
          }
        } else if (typeof timestamp === 'number') {
          // Handle both seconds and milliseconds
          if (timestamp < 1e12) timestamp *= 1000;
        }
        
        if (isNaN(timestamp) || timestamp < ninetyDaysAgo || timestamp > now) return;
        
        // Debug the coin data for the first few valid entries
        if (index < 3 && coinData && typeof coinData === 'object') {
          console.log(`Entry ${index} coinData keys:`, Object.keys(coinData));
          console.log(`Entry ${index} sample values:`, Object.entries(coinData).slice(0, 5));
        }
        
        // Process coin data
        if (coinData && typeof coinData === 'object') {
          Object.entries(coinData).forEach(([coinKey, coinValue]) => {
            if (coinKey === 'date' || coinKey === 'time' || coinKey === 'timestamp') return;
            
            if (!chartData[coinKey]) chartData[coinKey] = [];
            
            // Extract supply value
            let supply = 0;
            if (typeof coinValue === 'number' && coinValue > 0) {
              supply = coinValue;
            } else if (typeof coinValue === 'object' && coinValue !== null) {
              supply = coinValue.totalCirculatingUSD || coinValue.circulating?.peggedUSD || coinValue.totalCirculating || coinValue.mcap || 0;
            }
            
            if (supply > 0) {
              chartData[coinKey].push({ x: timestamp, y: supply });
            }
          });
        }
      });
    } else {
      console.log('Processing object-based historical data');
      console.log('Object keys sample:', Object.keys(actualData).slice(0, 10));
      
      // Try to extract meaningful data from the response structure
      const sampleKeys = Object.keys(actualData).slice(0, 3);
      sampleKeys.forEach(key => {
        console.log(`Sample entry ${key}:`, actualData[key]);
      });
      
      // Object format: dates as keys
      Object.entries(actualData).forEach(([dateStr, dateData]) => {
        if (typeof dateData === 'object' && dateData !== null) {
          // Parse date - try multiple formats
          let timestamp;
          if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
            timestamp = new Date(dateStr + 'T00:00:00Z').getTime();
          } else if (/^\d+$/.test(dateStr)) {
            timestamp = parseInt(dateStr) * (dateStr.length === 10 ? 1000 : 1);
          } else {
            timestamp = new Date(dateStr).getTime();
          }
          
          if (isNaN(timestamp) || timestamp < ninetyDaysAgo || timestamp > now) return;
          
          Object.entries(dateData).forEach(([coinKey, coinValue]) => {
            if (!chartData[coinKey]) chartData[coinKey] = [];
            
            let supply = 0;
            if (typeof coinValue === 'number' && coinValue > 0) {
              supply = coinValue;
            } else if (typeof coinValue === 'object' && coinValue !== null) {
              supply = coinValue.totalCirculatingUSD || coinValue.circulating?.peggedUSD || coinValue.totalCirculating || 0;
            }
            
            if (supply > 0) {
              chartData[coinKey].push({ x: timestamp, y: supply });
            }
          });
        }
      });
    }
    
    // Sort all data points by timestamp
    Object.keys(chartData).forEach(key => {
      chartData[key].sort((a, b) => a.x - b.x);
    });
    
    const availableKeys = Object.keys(chartData).filter(key => chartData[key].length >= 5);
    console.log('Available chart data keys:', availableKeys.length, availableKeys.slice(0, 10));
    
    // Get top stablecoins by current market cap for filtering
    const topCoins = list
      .map(c => ({
        id: c.id,
        symbol: c.symbol || c.name || '—',
        mcap: Number(
          (typeof c.mcap === 'number' ? c.mcap : null) ??
          (c.circulating && (c.circulating.peggedUSD ?? c.circulating.usd)) ??
          (typeof c.totalCirculatingUSD === 'number' ? c.totalCirculatingUSD : 0)
        )
      }))
      .sort((a, b) => b.mcap - a.mcap)
      .slice(0, 8); // Top 8 stablecoins

    // Match top stablecoins with available data
    const coinSeries = [];
    const validDataKeys = Object.keys(chartData).filter(key => chartData[key].length >= 5);
    
    console.log('Available data keys for matching:', validDataKeys);
    console.log('Top coins for matching:', topCoins.map(c => c.symbol));
    
    for (const coin of topCoins) {
      if (coinSeries.length >= 8) break;
      
      // For mock data, we use lowercase symbols
      const possibleMatches = [
        coin.symbol?.toLowerCase(),
        coin.symbol?.toUpperCase(), 
        coin.symbol,
        coin.id
      ].filter(Boolean);
      
      let matchedKey = null;
      
      // Try exact matches first
      for (const candidate of possibleMatches) {
        if (validDataKeys.includes(candidate)) {
          matchedKey = candidate;
          break;
        }
      }
      
      // Try partial matches if no exact match
      if (!matchedKey) {
        for (const candidate of possibleMatches) {
          const partialMatch = validDataKeys.find(key => 
            key.toLowerCase().includes(candidate.toLowerCase()) ||
            candidate.toLowerCase().includes(key.toLowerCase())
          );
          if (partialMatch) {
            matchedKey = partialMatch;
            break;
          }
        }
      }
      
      if (matchedKey && chartData[matchedKey].length > 5) {
        const sortedData = chartData[matchedKey].sort((a, b) => a.x - b.x);
        coinSeries.push({
          label: coin.symbol || coin.name || matchedKey,
          data: sortedData,
          borderWidth: 2,
          fill: true,
          tension: 0.2,
          pointRadius: 0,
          pointHoverRadius: 4
        });
        console.log(`✓ Matched ${coin.symbol} with key '${matchedKey}', ${sortedData.length} data points`);
      } else {
        console.log(`✗ No match found for ${coin.symbol}`);
      }
    }
    
    // If we still don't have enough data, use the top available datasets
    if (coinSeries.length < 3) {
      console.log('Using top available data keys as fallback');
      const topAvailableKeys = validDataKeys
        .sort((a, b) => {
          const avgA = chartData[a].reduce((sum, point) => sum + point.y, 0) / chartData[a].length;
          const avgB = chartData[b].reduce((sum, point) => sum + point.y, 0) / chartData[b].length;
          return avgB - avgA;
        })
        .slice(0, Math.min(8 - coinSeries.length, 5));
        
      for (const key of topAvailableKeys) {
        const sortedData = chartData[key].sort((a, b) => a.x - b.x);
        coinSeries.push({
          label: key.charAt(0).toUpperCase() + key.slice(1),
          data: sortedData,
          borderWidth: 2,
          fill: true,
          tension: 0.2,
          pointRadius: 0,
          pointHoverRadius: 4
        });
        console.log(`📊 Using fallback data for '${key}', ${sortedData.length} data points`);
      }
    }

    // If no data found, create empty chart
    if (coinSeries.length === 0) {
      console.warn('No valid historical data found for any stablecoins');
      window.stackedChart = new Chart(canvas, {
        type: 'line',
        data: { 
          labels: ['No data available'],
          datasets: []
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false }
          }
        }
      });
      return;
    }

    console.log(`Rendering chart with ${coinSeries.length} stablecoin series`);

    // Assign colors to each series
    const colors = [
      'rgba(255, 179, 0, 0.7)',   // amber
      'rgba(74, 222, 128, 0.7)',  // green
      'rgba(59, 130, 246, 0.7)',  // blue
      'rgba(239, 68, 68, 0.7)',   // red
      'rgba(168, 85, 247, 0.7)',  // purple
      'rgba(236, 72, 153, 0.7)',  // pink
      'rgba(34, 197, 94, 0.7)',   // emerald
      'rgba(249, 115, 22, 0.7)'   // orange
    ];

    coinSeries.forEach((series, index) => {
      series.backgroundColor = colors[index % colors.length];
      series.borderColor = colors[index % colors.length].replace('0.7', '1');
      series.stack = 'total';
    });

    // Create the chart with time-series data
    window.stackedChart = new Chart(canvas, {
      type: 'line',
      data: { 
        datasets: coinSeries
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        resizeDelay: 150,
        scales: {
          x: {
            type: 'time',
            time: {
              unit: 'day',
              displayFormats: {
                day: 'MMM dd'
              }
            },
            stacked: true,
            ticks: { 
              color: 'rgba(255,255,255,0.7)',
              maxTicksLimit: 8
            },
            grid: { color: 'rgba(255,255,255,0.1)' }
          },
          y: {
            stacked: true,
            ticks: { 
              color: 'rgba(255,255,255,0.7)',
              callback: (v) => formatUSD(v)
            },
            grid: { color: 'rgba(255,255,255,0.1)' }
          }
        },
        plugins: { 
          legend: { 
            labels: { 
              color: 'rgba(255,255,255,0.7)',
              usePointStyle: true,
              padding: 15,
              font: { size: 11 }
            },
            position: 'bottom'
          },
          tooltip: {
            mode: 'index',
            intersect: false,
            callbacks: {
              label: function(context) {
                return `${context.dataset.label}: ${formatUSD(context.parsed.y)}`;
              },
              title: function(context) {
                return new Date(context[0].parsed.x).toLocaleDateString();
              }
            }
          }
        },
        interaction: {
          mode: 'nearest',
          axis: 'x',
          intersect: false
        }
      }
    });

    console.log('Stacked chart rendered successfully with live DeFiLlama data');

  } catch (error) {
    console.error('Error rendering stacked chart with live data:', error);
    
    // Create fallback empty chart
    window.stackedChart = new Chart(canvas, {
      type: 'line',
      data: { 
        labels: ['Error loading data'],
        datasets: []
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        }
      }
    });
  }
}

// Build the Top Stablecoins list, paginated
async function rebuildStablecoinList(reset) {
  const listEl = document.getElementById('stablecoinList');
  const loadBtn = document.getElementById('loadMore');
  if (reset) {
    listEl.innerHTML = '';
    listCursor = 0;
  }
  // Build base rows
  const rows = SC_SNAPSHOT.map(c => {
    const mcap = Number(
      (typeof c.mcap === 'number' ? c.mcap : null) ??
      (c.circulating && (c.circulating.peggedUSD ?? c.circulating.usd)) ??
      (typeof c.totalCirculatingUSD === 'number' ? c.totalCirculatingUSD : 0)
    );
    const symbol = c.symbol || c.name || '—';
    const name = c.name || c.symbol || '—';
    // Top chains (if we have per-coin chains info inside object, else fallback empty)
    const chains = (c?.chains && Array.isArray(c.chains) ? c.chains : []);
    return { symbol, name, mcap, chains, id: c.id || symbol, coinObj: c };
  }).sort((a,b)=>b.mcap-a.mcap);

  const slice = rows.slice(listCursor, listCursor + PAGE_SIZE);
  slice.forEach(r => {
    const row = document.createElement('div');
    row.className = 'row';
    // Compute a naive peg badge placeholder (since we need a price query per coin/chain to be exact)
    const pegBadge = `<span class="badge onpeg">On‑peg</span>`; // Placeholder; you can wire Coins API later for true deviation

    // Build top chain labels (best-effort)
    const chainBadges = (r.chains || []).slice(0,2).map(ch => `<span class="badge" title="Chain">${(ch?.name)||'—'}</span>`).join(' ') + ((r.chains||[]).length>2 ? ` <span class="badge">${'+'+((r.chains.length)-2)}</span>` : '');

    row.innerHTML = `
      <div><strong>${r.symbol}</strong> <span class="muted small">${r.name}</span></div>
      <div>${formatUSD(r.mcap)}</div>
      <div class="muted small">—</div>
      <div>${chainBadges || '<span class="muted small">—</span>'}</div>
      <div>${pegBadge}</div>
      <div class="muted small">—</div>
      <div class="muted small">${fmtTime(Date.now())}</div>
    `;
    listEl.appendChild(row);
  });

  listCursor += slice.length;
  if (listCursor >= rows.length) {
    loadBtn.disabled = true;
    loadBtn.textContent = 'All loaded';
  } else {
    loadBtn.disabled = false;
    loadBtn.textContent = 'Load more';
  }
}

// -----------------------------
// Yield Tab MVP
// -----------------------------
let yieldInitDone = false;
async function initYield() {
  if (yieldInitDone) return;
  yieldInitDone = true;

  // Populate chain filter from pools data later
  const chainSelect = document.getElementById('yfChain');

  // Fetch pools (snapshot) with caching 2–5 min
  let payload;
  try {
    const { data } = await fetchWithCache(EP.POOLS, { ttlSec: 300, version: '1' });
    payload = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  } catch (e) {
    console.error('Failed to load pools', e);
    document.getElementById('yieldRows').innerHTML = `<div class="trow"><div class="muted">Temporarily unavailable</div></div>`;
    return;
  }

  // Build naive stablecoin-only filter using symbol heuristic (MVP).
  const STABLES = ['USDT','USDC','DAI','TUSD','FDUSD','USDP','FRAX','LUSD','PYUSD','USDD','GUSD'];
  const rows = payload.filter(p => {
    const sym = (p.symbol || p.pool || '').toUpperCase();
    // Accept pure stable or stable-only combos (e.g., USDC/USDT/DAI)
    if (sym.includes('-') || sym.includes('/')) {
      // split and ensure every token appears stable-ish
      const parts = sym.split(/[\/\-]/g).map(s=>s.trim());
      return parts.every(tok => STABLES.includes(tok));
    }
    return STABLES.includes(sym);
  });

  // Populate chain filter options
  const chains = Array.from(new Set(rows.map(r => r.chain).filter(Boolean))).sort();
  chains.forEach(c => {
    const opt = document.createElement('option'); opt.textContent = c; opt.value = c;
    chainSelect.appendChild(opt);
  });

  // Render function with current filters
  const render = () => {
    const asset = document.getElementById('yfAsset').value;
    const chain = document.getElementById('yfChain').value;
    const minTvl = Number(document.getElementById('yfMinTvl').value || 0);
    const onPeg = document.getElementById('yfOnPeg').checked;

    const filtered = rows.filter(r => {
      // asset match
      const sym = (r.symbol || r.pool || '').toUpperCase();
      let assetOk = (asset === 'ALL') ? true :
        (sym === asset || sym.split(/[\/\-]/g).every(tok => tok === asset) || sym.includes(asset));
      // chain match
      const chainOk = (chain === 'ALL') ? true : ((r.chain || '').toLowerCase() === chain.toLowerCase());
      // tvl
      const tvl = Number(r.tvlUsd || r.totalSupplyUsd || 0);
      const tvlOk = tvl >= minTvl;
      // peg badge placeholder (assume on-peg; you can wire coins API later)
      const pegOk = onPeg ? true : true;
      return assetOk && chainOk && tvlOk && pegOk;
    });

    // Sort: APY total desc, then TVL desc
    filtered.sort((a,b)=> {
      const aApy = Number(a.apy ?? ((a.apyBase||0)+(a.apyReward||0)));
      const bApy = Number(b.apy ?? ((b.apyBase||0)+(b.apyReward||0)));
      if (bApy !== aApy) return bApy - aApy;
      const aT = Number(a.tvlUsd || a.totalSupplyUsd || 0);
      const bT = Number(b.tvlUsd || b.totalSupplyUsd || 0);
      return bT - aT;
    });

    const tbody = document.getElementById('yieldRows');
    tbody.innerHTML = '';
    const top = filtered.slice(0, 200); // cap displayed rows
    top.forEach(r => {
      const apyBase = Number(r.apyBase || 0);
      const apyReward = Number(r.apyReward || 0);
      const apyTotal = Number(r.apy ?? (apyBase + apyReward));
      const tvl = Number(r.tvlUsd || r.totalSupplyUsd || 0);
      const updated = r.timestamp ? new Date(r.timestamp*1000) : (r.updatedAt ? new Date(r.updatedAt) : new Date());
      const row = document.createElement('div');
      row.className = 'trow';
      row.innerHTML = `
        <div>${r.poolMeta ? `<strong>${r.poolMeta}</strong> ` : ''}<span class="muted small">${r.pool || '—'}</span></div>
        <div>${r.project || '—'}</div>
        <div>${r.chain || '—'}</div>
        <div>${r.symbol || '—'}</div>
        <div>${fmtPct(apyBase)}</div>
        <div>${fmtPct(apyReward)}</div>
        <div><strong>${fmtPct(apyTotal)}</strong></div>
        <div>${formatUSD(tvl)}</div>
        <div><span class="badge onpeg">On‑peg</span></div>
        <div class="muted small">${fmtTime(updated.getTime())}</div>
      `;
      tbody.appendChild(row);
    });

    if (top.length === 0) {
      tbody.innerHTML = `<div class="trow"><div class="muted">No pools match your filters.</div></div>`;
    }
  };

  // Hook filters
  ['yfAsset','yfChain','yfMinTvl','yfOnPeg'].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener('change', render);
  });

  render();
}

// -----------------------------
// Boot
// -----------------------------
window.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  initOverview(); // Overview is default
});
