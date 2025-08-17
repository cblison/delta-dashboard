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

  // Store chart instance globally to prevent multiple instances
  window.donutChart = new Chart(canvas, {
    type: 'doughnut',
    data: { labels, datasets: [{ data }]},
    options: {
      plugins: { legend: { labels: { color: '#fff' }, position: 'bottom' } }, responsive: true, maintainAspectRatio: true, aspectRatio: 1, cutout: '60%',
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

// ===============================
// PLASMA ECOSYSTEM FUNCTIONALITY
// ===============================

let ecosystemData = [];
let filteredData = [];
let currentCategory = 'all';
let currentSearch = '';

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
    
    filteredData = [...ecosystemData];
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
