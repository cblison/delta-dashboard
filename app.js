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
      const target = tab.dataset.target;
      
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      sections.forEach(s => s.classList.add('hidden'));
      document.getElementById(target).classList.remove('hidden');
      
      // Lazy init on first show
      if (target === 'yield') {
        initYield();
      } else if (target === 'overview') {
        initOverview();
      } else if (target === 'plasma') {
        setTimeout(initPlasma, 100); // Small delay to ensure tab is visible
      }
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

async function initOverview() {
  if (overviewInitDone) return;
  overviewInitDone = true;

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
}

function computeKPIs(list, chainSplit) {
  // Extract market cap from live data structure
  const rows = list.map(c => {
    const mcap = Number(
      (c.circulating && c.circulating.peggedUSD) ??
      (c.circulating && c.circulating.usd) ??
      (typeof c.mcap === 'number' ? c.mcap : 0)
    );
    return { 
      symbol: c.symbol || c.name || '—', 
      mcap: mcap || 0, 
      id: c.id || c.symbol || c.name || '',
      pegType: c.pegType || '—'
    };
  }).filter(r => r.mcap > 0); // Only count stablecoins with market cap

  rows.sort((a,b) => b.mcap - a.mcap);
  const total = rows.reduce((s,r)=>s+r.mcap,0);
  const top = rows[0] || { mcap: 0, symbol: '—' };
  const dominance = total>0 ? (top.mcap/total*100) : 0;

  document.getElementById('kpiTotalMcap').textContent = formatUSD(total);
  document.getElementById('kpiTopDominance').textContent = `${fmtPct(dominance)} (${top.symbol})`;
  document.getElementById('kpiCountCoins').textContent = rows.length.toString();

  // Chains > $100m: calculate from live data
  let bigChains = 0;
  if (chainSplit && Array.isArray(chainSplit)) {
    // chainSplit is an array of chains with totalCirculating
    bigChains = chainSplit.filter(ch => {
      const totalUSD = ch.totalCirculatingUSD?.peggedUSD || 0;
      return Number(totalUSD) > 100_000_000;
    }).length;
  }
  document.getElementById('kpiBigChains').textContent = bigChains ? String(bigChains) : '—';
}

function renderDonut(list) {
  if (!window.Chart) return; // Chart.js not loaded
  
  // Destroy existing chart if it exists
  if (window.donutChart) {
    window.donutChart.destroy();
  }
  
  // Brand colors for stablecoins
  const brandColors = {
    'USDT': '#26A17B', // Tether green
    'USDC': '#2775CA', // USDC blue
    'DAI': '#F5AC37', // DAI orange
    'FDUSD': '#2775CA', // FDUSD blue (similar to USDC)
    'USDP': '#2775CA', // USDP blue
    'FRAX': '#000000', // FRAX black
    'LUSD': '#5BBDF9', // LUSD light blue
    'PYUSD': '#FFD700', // PayPal gold
    'USDD': '#2775CA', // USDD blue
    'GUSD': '#2775CA', // GUSD blue
    'TUSD': '#2775CA', // TUSD blue
    'BUSD': '#F0B90B', // BUSD yellow
    'USDK': '#2775CA', // USDK blue
    'USDN': '#2775CA', // USDN blue
    'USDJ': '#2775CA', // USDJ blue
    'USDT0': '#26A17B', // USDT0 green (same as USDT)
    'USDE': '#8B4513', // USDE brown
    'USDe': '#000000', // USDe black (Ethena's USDe)
    'SUSDE': '#2775CA', // SUSDE blue
    'RLUSD': '#2775CA', // RLUSD blue
    'USDS': '#FF6B35', // USDS orange
    'USD1': '#2775CA', // USD1 blue
    'USD0': '#2775CA', // USD0 blue
    'USD.AI': '#2775CA', // USD.AI blue
    'USD₮0': '#26A17B', // USD₮0 green (same as USDT)
    'NUSD': '#2775CA', // NUSD blue
    'USD0': '#2775CA', // USD0 blue
    'lvlUSD': '#2775CA', // lvlUSD blue
    'XAUt': '#FFD700', // Tether Gold gold
    'TRYB': '#E30A17', // Turkish Lira red
    'CRVUSD': '#2775CA', // CRVUSD blue
    'SUSD': '#2775CA', // SUSD blue
    'GHO': '#2775CA', // GHO blue
    'MIM': '#2775CA', // MIM blue
    'DOLA': '#2775CA', // DOLA blue
    'USDM': '#2775CA', // USDM blue
    'EUSD': '#2775CA', // EUSD blue
    'MKUSD': '#2775CA', // MKUSD blue
    'USDC.E': '#2775CA', // USDC.E blue
    'USDBC': '#2775CA', // USDBC blue
    'Others': '#6B7280' // Gray for Others
  };
  
  const canvas = document.getElementById('chartDonut').getContext('2d');
  const rows = list.map(c => ({
    label: c.symbol || c.name || '—',
    mcap: Number(
      (c.circulating && c.circulating.peggedUSD) ??
      (c.circulating && c.circulating.usd) ??
      (typeof c.mcap === 'number' ? c.mcap : 0)
    )
  })).filter(r => r.mcap > 0); // Only include stablecoins with market cap
  rows.sort((a,b)=>b.mcap-a.mcap);
  const top5 = rows.slice(0,5);
  const others = rows.slice(5).reduce((s,r)=>s+r.mcap,0);
  const labels = [...top5.map(r=>r.label), 'Others'];
  const data = [...top5.map(r=>r.mcap), others];
  
  // Generate colors based on labels
  const backgroundColor = labels.map(label => {
    console.log('Label:', label, 'Color:', brandColors[label] || '#6B7280');
    return brandColors[label] || '#6B7280';
  });

  // Store chart instance globally to prevent multiple instances
  window.donutChart = new Chart(canvas, {
    type: 'doughnut',
    data: { 
      labels, 
      datasets: [{ 
        data,
        backgroundColor,
        borderColor: backgroundColor,
        borderWidth: 2
      }]
    },
    options: {
      plugins: { legend: { labels: { color: '#fff' }, position: 'bottom' } }, responsive: true, maintainAspectRatio: true, aspectRatio: 1, cutout: '60%',
      layout: { padding: 8 },
      animation: { duration: 0 },
      cache: false
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
    
    
    // Use the /stablecoincharts/all endpoint for total market cap over time
    const { data: response } = await fetchWithCache(
      'https://stablecoins.llama.fi/stablecoincharts/all',
      { ttlSec: 300, version: '1' }
    );
    
    if (!response || !Array.isArray(response) || response.length === 0) {
      console.warn('No historical data available from /stablecoincharts/all');
      createEmptyChart(canvas);
      return;
    }
    
    
    
    // Filter to last 90 days and parse data
    const now = Date.now();
    const ninetyDaysAgo = now - (90 * 24 * 60 * 60 * 1000);
    
    const chartData = response
      .map(dataPoint => {
        // Parse timestamp (DeFiLlama uses Unix timestamps)
        let timestamp = dataPoint.date;
        if (typeof timestamp === 'string') {
          timestamp = parseInt(timestamp);
        }
        if (timestamp < 1e12) {
          timestamp *= 1000; // Convert seconds to milliseconds
        }
        
        // Extract total circulating USD value
        const totalValue = dataPoint.totalCirculating?.peggedUSD || 0;
        
        return {
          x: timestamp,
          y: totalValue
        };
      })
      .filter(point => 
        point.x >= ninetyDaysAgo && 
        point.x <= now && 
        point.y > 0
      )
      .sort((a, b) => a.x - b.x);
    
    if (chartData.length < 2) {
      console.warn('Insufficient data points for chart');
      createEmptyChart(canvas);
      return;
    }
    
    
    
    // Create the chart
    window.stackedChart = new Chart(canvas, {
      type: 'line',
      data: {
        datasets: [{
          label: 'Total Stablecoin Market Cap',
          data: chartData,
          borderColor: 'rgba(74, 222, 128, 1)',
          backgroundColor: 'rgba(74, 222, 128, 0.1)',
          borderWidth: 3,
          fill: true,
          tension: 0.2,
          pointRadius: 0,
          pointHoverRadius: 6,
          pointHoverBackgroundColor: 'rgba(74, 222, 128, 1)',
          pointHoverBorderColor: '#ffffff',
          pointHoverBorderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 750 },
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
            ticks: { 
              color: 'rgba(255,255,255,0.7)',
              maxTicksLimit: 8
            },
            grid: { color: 'rgba(255,255,255,0.1)' }
          },
          y: {
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
              font: { size: 12 }
            },
            position: 'top'
          },
          tooltip: {
            mode: 'nearest',
            intersect: false,
            callbacks: {
              label: function(context) {
                return `Total Market Cap: ${formatUSD(context.parsed.y)}`;
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

    

  } catch (error) {
    console.error('Error rendering chart:', error);
    createEmptyChart(canvas);
  }
}

function createEmptyChart(canvas) {
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
}

// Build the Top Stablecoins list, paginated with live data
async function rebuildStablecoinList(reset) {
  const listEl = document.getElementById('stablecoinList');
  const loadBtn = document.getElementById('loadMore');
  if (reset) {
    listEl.innerHTML = '';
    listCursor = 0;
  }
  
  // Build base rows from live data
  const rows = SC_SNAPSHOT.map(c => {
    // Extract market cap from live data structure
    const mcap = Number(
      (c.circulating && c.circulating.peggedUSD) ??
      (c.circulating && c.circulating.usd) ??
      (typeof c.mcap === 'number' ? c.mcap : 0)
    );
    
    const symbol = c.symbol || c.name || '—';
    const name = c.name || c.symbol || '—';
    
    // Extract chain information from live data
    let chains = [];
    if (c.chainCirculating && typeof c.chainCirculating === 'object') {
      // Extract chain names from chainCirculating object
      chains = Object.keys(c.chainCirculating).map(chainName => ({
        name: chainName,
        amount: c.chainCirculating[chainName]?.current?.peggedUSD || 0
      })).filter(chain => chain.amount > 0)
        .sort((a, b) => b.amount - a.amount);
    }
    
    // Calculate market cap changes
    const prevDay = c.circulatingPrevDay?.peggedUSD || 0;
    const prevWeek = c.circulatingPrevWeek?.peggedUSD || 0;
    const prevMonth = c.circulatingPrevMonth?.peggedUSD || 0;
    
    const dayChange = prevDay > 0 ? ((mcap - prevDay) / prevDay * 100) : 0;
    const weekChange = prevWeek > 0 ? ((mcap - prevWeek) / prevWeek * 100) : 0;
    const monthChange = prevMonth > 0 ? ((mcap - prevMonth) / prevMonth * 100) : 0;
    
    return { 
      symbol, 
      name, 
      mcap, 
      chains, 
      id: c.id || symbol, 
      coinObj: c,
      pegType: c.pegType || '—',
      priceSource: c.priceSource || '—',
      pegMechanism: c.pegMechanism || '—',
      geckoId: c.gecko_id || null,
      dayChange,
      weekChange,
      monthChange,
      prevDay,
      prevWeek,
      prevMonth
    };
  }).filter(r => r.mcap > 0) // Only show stablecoins with market cap
    .sort((a, b) => b.mcap - a.mcap);

  // Use all rows (no filtering)
  const filteredRows = rows;

  const slice = filteredRows.slice(listCursor, listCursor + PAGE_SIZE);
  
  if (slice.length === 0) {
    const noDataRow = document.createElement('div');
    noDataRow.className = 'row';
    noDataRow.innerHTML = '<div class="muted">No stablecoins found</div>';
    listEl.appendChild(noDataRow);
    loadBtn.disabled = true;
    loadBtn.textContent = 'No data';
    return;
  }

  slice.forEach(r => {
    const row = document.createElement('div');
    row.className = 'row';
    
    // Build top chain labels from live data
    const chainBadges = r.chains.slice(0, 3).map(ch => 
      `<span class="badge" title="${ch.name}: ${formatUSD(ch.amount)}">${ch.name}</span>`
    ).join(' ') + (r.chains.length > 3 ? ` <span class="badge clickable" onclick="showChainModal('${r.symbol}', ${JSON.stringify(r.chains).replace(/"/g, '&quot;')})">+${r.chains.length - 3}</span>` : '');

    row.innerHTML = `
      <div><strong>${r.symbol}</strong> &nbsp;&nbsp; <span class="muted small">${r.name}</span></div>
      <div>${formatUSD(r.mcap)}</div>
      <div>${chainBadges || '<span class="muted small">—</span>'}</div>
    `;
    listEl.appendChild(row);
  });

  listCursor += slice.length;
  if (listCursor >= filteredRows.length) {
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
let yieldSort = { key: 'tvl', dir: 'desc' }; // default sort: TVL desc
async function initYield() {
  if (yieldInitDone) return;
  yieldInitDone = true;

  // Populate chain filter from pools data later
  const chainSelect = document.getElementById('yfChain');
  const yieldRowsEl = document.getElementById('yieldRows');
  if (yieldRowsEl) {
    yieldRowsEl.innerHTML = `<div class="trow"><div class="muted">Loading...</div></div>`;
  }

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

  // Stable-related pools (include any pool with at least one stable leg)
  const STABLES = new Set([
    'USDT','USDC','DAI','TUSD','FDUSD','USDP','FRAX','LUSD','PYUSD','USDD','GUSD',
    'CRVUSD','SUSD','GHO','MIM','DOLA','USD0','USDM','EUSD','MKUSD','USDC.E','USDBC',
    'USDE','SUSDE','RLUSD','USDS','USD1'
  ]);
  function tokenizeSymbol(sym){
    return String(sym || '').toUpperCase().split(/[^A-Z0-9]+/g).filter(Boolean);
  }
  function isExcludedPoolEntry(entry) {
    const text = `${entry.poolMeta || ''} ${entry.symbol || ''} ${entry.pool || ''}`.toUpperCase();
    // Exclude Pendle PT tokens and dated PT series
    if (text.includes('PT-')) return true;
    if (text.includes('PT-SUSDE') || text.includes('PT-USDE')) return true;
    if (text.includes('25SEP2025') || text.includes('25SEPT2025')) return true;
    // Exclude specific composite pairs and trailing-plus variants not on the stable list
    if (text.includes('AETHUSDE-AETHSUSDE')) return true;
    if (text.includes('USUALUSDC+')) return true;
    return false;
  }

  // Pretty-print project names from slug/ids
  const PROJECT_NAME_MAP = {
    'aave-v3': 'Aave V3',
    'curve-dex': 'Curve DEX',
    'morpho-blue': 'Morpho Blue',
    'justlend': 'JustLend',
    'yearn-finance': 'Yearn Finance',
    'arrakis-v1': 'Arrakis V1',
    'uniswap-v3': 'Uniswap V3',
    'balancer-v2': 'Balancer V2',
    'convex-finance': 'Convex Finance',
    'frax': 'Frax',
    'sky-lending': 'Sky Lending',
    'sparklend': 'SparkLend',
    'ethena-usde': 'Ethena USDe',
    'ethena': 'Ethena',
    'maple': 'Maple',
    'usual': 'Usual',
    'pendle': 'Pendle',
    'fluid-lending': 'Fluid Lending',
    'kamino-lend': 'Kamino Lend',
    'venus-core-pool': 'Venus Core Pool',
    'fx-protocol': 'fx Protocol',
    'reservoir-protocol': 'Reservoir Protocol',
    'yieldfi': 'YieldFi'
  };
  function titleCaseProject(str) {
    const words = String(str || '').split(/[^a-zA-Z0-9]+/g).filter(Boolean);
    const cased = words.map(w => {
      const up = w.toUpperCase();
      if (/(V\d+|DEX|DAO)/.test(up)) return up;
      if (up === 'USDE') return 'USDe';
      if (up === 'SUSDE') return 'SUSDE';
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    }).join(' ');
    return cased || str;
  }
  function formatProjectName(project) {
    const key = String(project || '').toLowerCase();
    return PROJECT_NAME_MAP[key] || titleCaseProject(project);
  }

  // Known project websites (prefer external site over internal pages)
  const PROJECT_WEBSITE_MAP = {
    'ethena-usde': 'https://www.ethena.fi/',
    'ethena': 'https://www.ethena.fi/',
    'maple': 'https://app.maple.finance/earn',
    'sky-lending': 'https://sky.money/',
    'aave-v3': 'https://app.aave.com/',
    'morpho-blue': 'https://app.morpho.org/',
    'usual': 'https://app.usual.money/',
    'justlend': 'https://justlend.just.network/',
    'yearn-finance': 'https://yearn.fi/',
    'arrakis-v1': 'https://www.arrakis.finance/',
    'uniswap-v3': 'https://app.uniswap.org/',
    'balancer-v2': 'https://app.balancer.fi/',
    'convex-finance': 'https://www.convexfinance.com/',
    'frax': 'https://frax.com/',
    'sparklend': 'https://app.spark.fi/',
    'fluid-lending': 'https://fluid.io/',
    'kamino-lend': 'https://app.kamino.finance/',
    'venus-core-pool': 'https://app.venus.io/'
  };
  function getProjectWebsite(project) {
    const key = String(project || '').toLowerCase();
    return PROJECT_WEBSITE_MAP[key] || null;
  }
  let rows = payload.filter(p => {
    const symUp = String(p.symbol || p.pool || '').toUpperCase();
    const tokens = tokenizeSymbol(symUp);
    if (tokens.length === 0) return false;
    const tokenHit = tokens.some(t => STABLES.has(t));
    const substringHit = Array.from(STABLES).some(s => symUp.includes(s));
    return tokenHit || substringHit;
  });
  // Remove explicitly excluded pools (e.g., PT-SUSDE-25SEP2025 variants)
  rows = rows.filter(r => !isExcludedPoolEntry(r));

  // Try to align exactly with DeFiLlama rankings by ingesting their CSV (best effort)
  try {
    // Lightweight CSV parser handling quotes
    function parseCSV(text) {
      const rows = [];
      let row = [];
      let cur = '';
      let inQuotes = false;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuotes) {
          if (ch === '"') {
            if (text[i+1] === '"') { cur += '"'; i++; }
            else { inQuotes = false; }
          } else { cur += ch; }
        } else {
          if (ch === '"') inQuotes = true;
          else if (ch === ',') { row.push(cur); cur = ''; }
          else if (ch === '\n' || ch === '\r') {
            if (cur.length || row.length) { row.push(cur); rows.push(row); row = []; cur = ''; }
          } else { cur += ch; }
        }
      }
      if (cur.length || row.length) { row.push(cur); rows.push(row); }
      return rows;
    }
    const csvRes = await fetch('https://datasets.llama.fi/yields/yield_rankings.csv', { cache: 'no-store' });
    if (csvRes.ok) {
      const csvText = await csvRes.text();
      const table = parseCSV(csvText);
      if (table && table.length > 1) {
        const header = table[0].map(h => h.trim().toLowerCase());
        const idx = (name) => header.indexOf(name);
        const idxPool = idx('pool') !== -1 ? idx('pool') : idx('pool id');
        const idxProject = idx('project');
        const idxChain = idx('chain');
        const idxSymbol = idx('symbol');
        const idxTvl = idx('tvl') !== -1 ? idx('tvl') : (idx('tvlusd') !== -1 ? idx('tvlusd') : -1);
        const idxApy = idx('apy');
        const idxApyBase = idx('apy (base)') !== -1 ? idx('apy (base)') : idx('apybase');
        const idxApyReward = idx('apy (reward)') !== -1 ? idx('apy (reward)') : idx('apyreward');
        let csvRows = table.slice(1).map(cols => ({
          pool: cols[idxPool] || '',
          project: cols[idxProject] || '',
          chain: cols[idxChain] || '',
          symbol: cols[idxSymbol] || '',
          tvlUsd: Number((cols[idxTvl] || '').toString().replace(/[$,]/g,'')) || 0,
          apy: Number(cols[idxApy] || 0),
          apyBase: Number(cols[idxApyBase] || 0),
          apyReward: Number(cols[idxApyReward] || 0),
        })).filter(r => {
          const symUp = String(r.symbol || r.pool || '').toUpperCase();
          const tokens = tokenizeSymbol(symUp);
          if (tokens.length === 0) return false;
          const tokenHit = tokens.some(t => STABLES.has(t));
          const substringHit = Array.from(STABLES).some(s => symUp.includes(s));
          return tokenHit || substringHit;
        });
        // Remove excluded entries from CSV too
        csvRows = csvRows.filter(r => !isExcludedPoolEntry(r));
        if (csvRows.length > 0) {
          rows = csvRows;
        }
      }
    }
  } catch {}

  // Populate chain filter options
  if (chainSelect) {
    const chains = Array.from(new Set(rows.map(r => r.chain).filter(Boolean))).sort();
    chains.forEach(c => {
      const opt = document.createElement('option'); opt.textContent = c; opt.value = c;
      chainSelect.appendChild(opt);
    });
  }

  // Populate project filter options
  const projectSelect = document.getElementById('yfProject');
  if (projectSelect) {
    const projects = Array.from(new Set(rows.map(r => r.project).filter(Boolean))).sort();
    projects.forEach(p => {
      const opt = document.createElement('option'); opt.textContent = formatProjectName(p); opt.value = p;
      projectSelect.appendChild(opt);
    });
  }

  // Header click sorting
  const sortBindings = [
    ['yfSortApyBase',   'apyBase'],
    ['yfSortApyReward', 'apyReward'],
    ['yfSortApyTotal',  'apyTotal'],
    ['yfSortTvl',       'tvl'],
  ];
  sortBindings.forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (!el) return;
    const toggle = () => {
      if (yieldSort.key === key) {
        yieldSort.dir = (yieldSort.dir === 'asc') ? 'desc' : 'asc';
      } else {
        yieldSort.key = key;
        yieldSort.dir = 'desc';
      }
      render();
    };
    el.addEventListener('click', toggle);
    el.addEventListener('keypress', (e)=>{ if(e.key==='Enter') toggle(); });
  });

  // Render function with current filters
  const render = () => {
    const search = (document.getElementById('yfSearch')?.value || '').toLowerCase();
    const asset = document.getElementById('yfAsset').value;
    const chain = document.getElementById('yfChain').value;
    const project = document.getElementById('yfProject')?.value || 'ALL';
    const minTvl = Number(document.getElementById('yfMinTvl').value || 0);
    const usdtOnly = !!document.getElementById('yfUsdtOnly')?.checked;

    const filtered = rows.filter(r => {
      // asset match
      const sym = (r.symbol || r.pool || '').toUpperCase();
      let assetOk = (asset === 'ALL') ? true :
        (sym === asset || sym.split(/[\/\-]/g).every(tok => tok === asset) || sym.includes(asset));
      // chain match
      const chainOk = (chain === 'ALL') ? true : ((r.chain || '').toLowerCase() === chain.toLowerCase());
      // project match
      const projectOk = (project === 'ALL') ? true : ((r.project || '').toLowerCase() === project.toLowerCase());
      // tvl
      const tvl = Number(r.tvlUsd ?? r.totalSupplyUsd ?? 0);
      const tvlOk = tvl >= minTvl;
      // USDT-only filter
      const symAll = String(r.symbol || r.pool || '').toUpperCase();
      const tokens = tokenizeSymbol(symAll);
      const usdtOk = usdtOnly ? (tokens.includes('USDT') || symAll.includes('USDT')) : true;
      // search
      const hay = `${r.poolMeta || ''} ${r.pool || ''} ${r.project || ''} ${r.chain || ''} ${r.symbol || ''}`.toLowerCase();
      const searchOk = !search || hay.includes(search);
      return assetOk && chainOk && projectOk && tvlOk && usdtOk && searchOk;
    });

    // Sort according to header selection
    filtered.sort((a,b)=> {
      const dir = (yieldSort.dir === 'asc') ? 1 : -1;

      const tvlA = Number(a.tvlUsd ?? a.totalSupplyUsd ?? 0);
      const tvlB = Number(b.tvlUsd ?? b.totalSupplyUsd ?? 0);
      const apyBaseA = Number(a.apyBase || 0),   apyBaseB = Number(b.apyBase || 0);
      const apyRewardA = Number(a.apyReward || 0), apyRewardB = Number(b.apyReward || 0);
      const apyTotalA = Number(a.apy ?? (apyBaseA + apyRewardA));
      const apyTotalB = Number(b.apy ?? (apyBaseB + apyRewardB));

      let cmp = 0;
      switch (yieldSort.key) {
        case 'apyBase':   cmp = (apyBaseA - apyBaseB); break;
        case 'apyReward': cmp = (apyRewardA - apyRewardB); break;
        case 'apyTotal':  cmp = (apyTotalA - apyTotalB); break;
        case 'tvl':
        default:          cmp = (tvlA - tvlB); break;
      }
      if (cmp !== 0) return cmp * dir;

      // tiebreakers
      if (tvlB !== tvlA) return tvlB - tvlA;
      return apyTotalB - apyTotalA;
    });

    const tbody = document.getElementById('yieldRows');
    tbody.innerHTML = '';
    // Ensure we display up to 100 rows: if exclusions reduce count, backfill with next rows by TVL
    let top = filtered.slice(0, 100);
    if (top.length < 100) {
      const have = new Set(top.map(r => r.pool || `${r.project}|${r.symbol}|${r.chain}`));
      // Build extras from all rows that passed base stable filter (rows), excluding already taken and excluded entries
      const extras = rows.filter(r => !have.has(r.pool || `${r.project}|${r.symbol}|${r.chain}`) && !isExcludedPoolEntry(r));
      // Sort extras by current sort (default TVL desc)
      extras.sort((a,b)=>{
        const dir = (yieldSort.dir === 'asc') ? 1 : -1;
        const tvlA = Number(a.tvlUsd ?? a.totalSupplyUsd ?? 0);
        const tvlB = Number(b.tvlUsd ?? b.totalSupplyUsd ?? 0);
        const apyBaseA = Number(a.apyBase || 0), apyBaseB = Number(b.apyBase || 0);
        const apyRewardA = Number(a.apyReward || 0), apyRewardB = Number(b.apyReward || 0);
        const apyTotalA = Number(a.apy ?? (apyBaseA + apyRewardA));
        const apyTotalB = Number(b.apy ?? (apyBaseB + apyRewardB));
        let cmp = 0;
        switch (yieldSort.key) {
          case 'apyBase':   cmp = (apyBaseA - apyBaseB); break;
          case 'apyReward': cmp = (apyRewardA - apyRewardB); break;
          case 'apyTotal':  cmp = (apyTotalA - apyTotalB); break;
          case 'tvl':
          default:          cmp = (tvlA - tvlB); break;
        }
        if (cmp !== 0) return cmp * dir;
        if (tvlB !== tvlA) return tvlB - tvlA;
        return apyTotalB - apyTotalA;
      });
      for (const r of extras) {
        if (top.length >= 100) break;
        top.push(r);
      }
    }

    // Update header active classes
    sortBindings.forEach(([id, key]) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.remove('active','asc','desc');
      if (yieldSort.key === key) {
        el.classList.add('active');
        el.classList.add(yieldSort.dir === 'asc' ? 'asc' : 'desc');
      }
    });
    top.forEach(r => {
      const apyBase = Number(r.apyBase || 0);
      const apyReward = Number(r.apyReward || 0);
      const apyTotal = Number(r.apy ?? (apyBase + apyReward));
      const tvl = Number(r.tvlUsd ?? r.totalSupplyUsd ?? 0);
      const row = document.createElement('div');
      row.className = 'trow';
      const symbolText = (r.symbol || '—');
      const metaText = r.poolMeta ? ` ${r.poolMeta}` : '';
      const projectLink = getProjectWebsite(r.project);
      row.innerHTML = `
        <div>${projectLink ? `<a href="${projectLink}" target="_blank" rel="noopener noreferrer"><strong>${symbolText}</strong></a>` : `<strong>${symbolText}</strong>`}<span class="muted small">${metaText}</span></div>
        <div>${formatProjectName(r.project) || '—'}</div>
        <div>${formatUSD(tvl)}</div>
        <div>${r.chain || '—'}</div>
        <div>${r.symbol || '—'}</div>
        <div>${fmtPct(apyBase)}</div>
        <div>${fmtPct(apyReward)}</div>
        <div><strong>${fmtPct(apyTotal)}</strong></div>
      `;
      tbody.appendChild(row);
    });

    if (top.length === 0) {
      tbody.innerHTML = `<div class="trow"><div class="muted">No pools match your filters.</div></div>`;
    }
  };

  // Hook filters
  ['yfAsset','yfChain','yfProject','yfMinTvl','yfUsdtOnly'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', render);
  });
  const searchEl = document.getElementById('yfSearch');
  if (searchEl) searchEl.addEventListener('input', render);

  render();

  
}

// ===============================
// PLASMA ECOSYSTEM FUNCTIONALITY
// ===============================

let ecosystemData = [];
let filteredData = [];
let currentCategory = 'all';
let currentSearch = '';

// Exclude these auto-added yield projects from Plasma ecosystem
const PLASMA_EXCLUDE = new Set([
  'aave-v3','ethena-usde','merkl','morpho-blue','sky-lending','maple','uniswap-v3','curve-dex','raydium-amm',
  'fluid-lending','convex-finance','fluid-dex','sparklend','yearn-finance','justlend','gmx-v2-perps','aerodrome-slipstream',
  'uniswap-v2','beefy','compound-v3','inverse-finance-firm','lista-lending','fx-protocol','kamino-liquidity','euler-v2',
  'kamino-lend','orca-dex','stream-finance','sdai','curve-llamalend','balancer-v3','venus-core-pool','echelon-market',
  'resupply','stake-dao','tectonic','balancer-v2','arrakis-v1','sparkdex-v3.1','upshift','multipli.fi','stusdt',
  'cetus-amm','crvusd','vvs-standard','extra-finance-leverage-farming','thalaswap-v2'
]);

// Initialize Plasma tab when first opened
function initPlasma() {
  if (ecosystemData.length === 0) {
    loadEcosystemData();
  }
  setupPlasmaEventListeners();
}

// Load ecosystem data
async function loadEcosystemData() {
  try {
    // Try to load from ecosystem-data.js file
    if (typeof window.ecosystemPartners !== 'undefined') {
      ecosystemData = window.ecosystemPartners;
      
    } else {
      console.warn('Ecosystem data not found, using fallback data');
      // Fallback data if file not found
      ecosystemData = [
        {
          name: "USD₮0",
          logo: "logos/usdt0.svg",
          url: "https://usdt0.com",
          categories: ["stablecoins"],
          description: "Next-generation stablecoin with enhanced stability mechanisms"
        },
        {
          name: "Ethena",
          logo: "logos/ethena.svg", 
          url: "https://ethena.fi",
          categories: ["yield", "stablecoins"],
          description: "Synthetic dollar protocol built on Ethereum"
        },
        {
          name: "Curve Finance",
          logo: "logos/curve.svg",
          url: "https://curve.fi",
          categories: ["dex"],
          description: "Decentralized exchange optimized for stablecoin trading"
        }
      ];
    }
    
    // Remove excluded auto-added yield projects
    ecosystemData = (ecosystemData || []).filter(p => !PLASMA_EXCLUDE.has(String(p.name || '').toLowerCase()));
    filteredData = [...ecosystemData];
    // Update dynamic partner count
    const countEl = document.getElementById('plasmaPartnerCount');
    if (countEl) {
      countEl.textContent = String(ecosystemData.length);
    }
    renderPartners();
    
  } catch (error) {
    console.error('Error loading ecosystem data:', error);
    document.getElementById('plasmaGrid').innerHTML = 
      '<div class="card"><p>Error loading partner data. Please try again later.</p></div>';
  }
}

// Setup event listeners
function setupPlasmaEventListeners() {
  // Search functionality
  const searchInput = document.getElementById('plasmaSearch');
  if (searchInput && !searchInput.hasEventListener) {
    searchInput.addEventListener('input', debounce(handleSearch, 300));
    searchInput.hasEventListener = true;
    
    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchInput.focus();
      }
      if (e.key === 'Escape') {
        searchInput.blur();
        if (searchInput.value) {
          searchInput.value = '';
          handleSearch();
        }
      }
    });
  }
  
  // Filter buttons
  const filterButtons = document.querySelectorAll('.filter-btn');
  filterButtons.forEach(btn => {
    if (!btn.hasEventListener) {
      btn.addEventListener('click', () => handleFilter(btn.dataset.category));
      btn.hasEventListener = true;
    }
  });
}

// Handle search
function handleSearch() {
  const searchInput = document.getElementById('plasmaSearch');
  currentSearch = searchInput.value.toLowerCase().trim();
  applyFilters();
}

// Handle filter
function handleFilter(category) {
  currentCategory = category;
  
  // Update active filter button
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  document.querySelector(`[data-category="${category}"]`).classList.add('active');
  
  applyFilters();
}

// Apply filters and search
function applyFilters() {
  filteredData = ecosystemData.filter(partner => {
    // Category filter
    const categoryMatch = currentCategory === 'all' || 
                         partner.categories.includes(currentCategory);
    
    // Search filter
    const searchMatch = !currentSearch ||
                       partner.name.toLowerCase().includes(currentSearch) ||
                       partner.description.toLowerCase().includes(currentSearch) ||
                       partner.categories.some(cat => cat.toLowerCase().includes(currentSearch));
    
    return categoryMatch && searchMatch;
  });
  
  renderPartners();
}

// Render partners
function renderPartners() {
  const grid = document.getElementById('plasmaGrid');
  const noResults = document.getElementById('plasmaNoResults');
  
  if (!grid || !noResults) return;
  
  if (filteredData.length === 0) {
    grid.style.display = 'none';
    noResults.classList.remove('hidden');
    return;
  }
  
  grid.style.display = 'grid';
  noResults.classList.add('hidden');
  
  grid.innerHTML = filteredData.map(partner => {
    // Create a safe fallback SVG with proper encoding
    const fallbackSvg = createFallbackSvg(partner.name);
    
    return `
      <div class="partner-card" onclick="window.open('${partner.url}', '_blank')">
        <div class="partner-logo">
          <img src="${partner.logo}" alt="${partner.name}" onerror="this.src='${fallbackSvg}'">
        </div>
        <h3 class="partner-name">${partner.name}</h3>
        <div class="partner-categories">
          ${partner.categories.map(cat => 
            `<span class="category-tag">${cat}</span>`
          ).join('')}
        </div>
        <p class="partner-description">${partner.description}</p>
      </div>
    `;
  }).join('');
  
  
}

function slugifyProjectName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

async function fetchTopStablecoinYieldProjects(limit = 50) {
  let payload;
  try {
    const { data } = await fetchWithCache(EP.POOLS, { ttlSec: 300, version: '1' });
    payload = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  } catch {
    return [];
  }

  const STABLES = new Set([
    'USDT','USDC','DAI','TUSD','FDUSD','USDP','FRAX','LUSD','PYUSD','USDD','GUSD',
    'CRVUSD','SUSD','GHO','MIM','DOLA','USD0','USDM','EUSD','MKUSD','USDC.E','USDBC',
    'USDE','SUSDE','RLUSD','USDS','USD1'
  ]);
  function tokenizeSymbol(sym){
    return String(sym || '').toUpperCase().split(/[^A-Z0-9]+/g).filter(Boolean);
  }
  const rows = payload.filter(p => {
    const symUp = String(p.symbol || p.pool || '').toUpperCase();
    const tokens = tokenizeSymbol(symUp);
    if (tokens.length === 0) return false;
    const tokenHit = tokens.some(t => STABLES.has(t));
    const substringHit = Array.from(STABLES).some(s => symUp.includes(s));
    return tokenHit || substringHit;
  });
  const projectToTvl = new Map();
  for (const r of rows) {
    const project = r.project || '';
    if (!project) continue;
    const tvl = Number(r.tvlUsd ?? r.totalSupplyUsd ?? 0);
    projectToTvl.set(project, (projectToTvl.get(project) || 0) + tvl);
  }
  return Array.from(projectToTvl.entries())
    .map(([project, tvl]) => ({ project, tvl }))
    .sort((a,b) => b.tvl - a.tvl)
    .slice(0, limit);
}

function augmentEcosystemWithTopYieldProjects(topProjects) {
  const existing = new Set((ecosystemData || []).map(p => String(p.name || '').toLowerCase()));
  for (const { project } of topProjects) {
    const key = String(project || '').toLowerCase();
    if (!key || existing.has(key)) continue;
    const slug = slugifyProjectName(project);
    ecosystemData.push({
      name: project,
      logo: `logos/${slug}.svg`,
      url: 'https://defillama.com/yields/stablecoins',
      categories: ['yield'],
      description: `${project} appears among the top projects by stablecoin TVL (auto‑added).`
    });
    existing.add(key);
  }
}

// Add this new function to create properly encoded fallback SVGs
function createFallbackSvg(partnerName) {
  // Get the first character and handle it safely
  const firstChar = partnerName.charAt(0);
  
  // Create a simple, safe SVG fallback
  const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60" viewBox="0 0 60 60"><rect width="60" height="60" fill="#4ade80" rx="10"/><text x="30" y="35" text-anchor="middle" fill="white" font-size="20" font-weight="bold" font-family="Arial, sans-serif">${firstChar}</text></svg>`;
  
  // Properly encode the SVG for use as a data URL using base64
  return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgContent)));
}

// Clear all filters
function clearPlasmaFilters() {
  currentCategory = 'all';
  currentSearch = '';
  
  const searchInput = document.getElementById('plasmaSearch');
  if (searchInput) searchInput.value = '';
  
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  const allBtn = document.querySelector('[data-category="all"]');
  if (allBtn) allBtn.classList.add('active');
  
  applyFilters();
}

// Make clearPlasmaFilters globally accessible
window.clearPlasmaFilters = clearPlasmaFilters;

// Debounce utility
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// -----------------------------
// Chain Modal Functions
// -----------------------------

// Show chain modal with all chains for a stablecoin
function showChainModal(symbol, chains) {
  const modal = document.getElementById('chainModal');
  const modalSymbol = document.getElementById('modalSymbol');
  const modalChains = document.getElementById('modalChains');
  
  if (!modal || !modalSymbol || !modalChains) return;
  
  // Set the symbol in the title
  modalSymbol.textContent = symbol;
  
  // Sort chains by amount (highest first)
  const sortedChains = [...chains].sort((a, b) => b.amount - a.amount);
  
  // Generate chain list HTML
  const chainsHTML = sortedChains.map(chain => `
    <div class="chain-item">
      <div class="chain-name">${chain.name}</div>
      <div class="chain-amount">${formatUSD(chain.amount)}</div>
    </div>
  `).join('');
  
  modalChains.innerHTML = chainsHTML;
  
  // Show modal
  modal.classList.remove('hidden');
  
  // Close modal when clicking outside
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeChainModal();
    }
  });
}

// Close chain modal
function closeChainModal() {
  const modal = document.getElementById('chainModal');
  if (modal) {
    modal.classList.add('hidden');
  }
}

// Make functions globally accessible
window.showChainModal = showChainModal;
window.closeChainModal = closeChainModal;



// -----------------------------
// Boot
// -----------------------------
window.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  initOverview(); // Overview is default
});
