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
      if (target === 'overview') {
        initOverview();
      } else if (target === 'historical') {
        setTimeout(initHistorical, 50);
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

// ===============================
// HISTORICAL TAB LOGIC (inline import from historical page)
// ===============================

const HIST_API_LIST = 'https://stablecoins.llama.fi/stablecoins';
const HIST_API_ASSET = (id) => `https://stablecoins.llama.fi/stablecoin/${id}`;

let HIST_allAssets = [];
let HIST_filteredAssets = [];
let HIST_marketCapChart = null;
let HIST_stackedChart = null;
let historicalInitDone = false;

function histFormatUSD(x) {
  if (x == null || isNaN(x)) return '—';
  const abs = Math.abs(x);
  const fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
  if (abs >= 1e12) return '$' + fmt.format(x / 1e12) + 'T';
  if (abs >= 1e9) return '$' + fmt.format(x / 1e9) + 'B';
  if (abs >= 1e6) return '$' + fmt.format(x / 1e6) + 'M';
  if (abs >= 1e3) return '$' + fmt.format(x / 1e3) + 'K';
  return '$' + fmt.format(x);
}

function histSetStatus(msg, type = 'info') {
  const el = document.getElementById('histStatus');
  if (!el) return;
  el.textContent = msg || '';
  el.className = 'hist-footnote' + (type === 'error' ? ' error' : '');
}

async function histFetchJSON(url) {
  const res = await fetch(url, { headers: { 'accept': 'application/json' } });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  return res.json();
}

function histRenderAssetList() {
  const list = document.getElementById('histAssetList');
  const mobileSelect = document.getElementById('histMobileSelect');
  if (!list) return;
  list.innerHTML = '';
  if (mobileSelect) mobileSelect.innerHTML = '';
  HIST_filteredAssets.forEach((a) => {
    const div = document.createElement('div');
    div.className = 'hist-asset';
    div.innerHTML = `
      <div>
        <span class="name">${a.name}</span>
        <span class="symbol">${a.symbol || ''}</span>
      </div>
      <div class="circulating">${histFormatUSD(a.circulating?.peggedUSD || 0)}</div>
    `;
    div.onclick = () => histSelectAsset(a);
    list.appendChild(div);

    if (mobileSelect) {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = `${a.name} ${a.symbol ? `(${a.symbol})` : ''}`;
      mobileSelect.appendChild(opt);
    }
  });
  if (mobileSelect) {
    mobileSelect.onchange = () => {
      const id = mobileSelect.value;
      const a = HIST_filteredAssets.find(x => String(x.id) === String(id));
      if (a) histSelectAsset(a);
    };
  }
}

function histFilterAssets(term) {
  const t = (term || '').trim().toLowerCase();
  if (!t) {
    HIST_filteredAssets = HIST_allAssets;
  } else {
    HIST_filteredAssets = HIST_allAssets.filter(a =>
      a.name.toLowerCase().includes(t) || (a.symbol || '').toLowerCase().includes(t)
    );
  }
  histRenderAssetList();
}

function histPrepareColors(n) {
  const base = [
    '#3ea6ff','#8b5cf6','#22c55e','#ef4444','#f59e0b','#14b8a6','#e879f9',
    '#60a5fa','#f97316','#a3e635','#f43f5e','#2dd4bf','#fb7185','#34d399'
  ];
  const colors = [];
  for (let i = 0; i < n; i++) colors.push(base[i % base.length]);
  return colors;
}

function histBuildTimeIndex(chainBalances) {
  const chainSeries = {};
  const allDatesSet = new Set();
  const chains = Object.keys(chainBalances || {});
  for (const chain of chains) {
    const arr = chainBalances[chain]?.tokens || [];
    const series = arr
      .filter(p => p && p.date && p.circulating && typeof p.circulating.peggedUSD === 'number')
      .map(p => ({ t: p.date * 1000, v: p.circulating.peggedUSD }))
      .sort((a, b) => a.t - b.t);
    chainSeries[chain] = series;
    series.forEach(p => allDatesSet.add(p.t));
  }
  const allDates = Array.from(allDatesSet).sort((a, b) => a - b);
  const chainToUnified = {};
  for (const chain of Object.keys(chainSeries)) {
    const src = chainSeries[chain];
    const unified = [];
    let idx = 0;
    let last = 0;
    for (const t of allDates) {
      while (idx < src.length && src[idx].t <= t) {
        last = src[idx].v;
        idx++;
      }
      unified.push({ t, v: last });
    }
    chainToUnified[chain] = unified;
  }
  return { chains: Object.keys(chainToUnified), allDates, chainToUnified };
}

function histComputeTopChains(chainToUnified, allDates, topN = 8) {
  const latestIdx = allDates.length - 1;
  const entries = Object.entries(chainToUnified).map(([chain, series]) => {
    const latest = latestIdx >= 0 ? (series[latestIdx]?.v || 0) : 0;
    return [chain, latest];
  }).sort((a, b) => b[1] - a[1]);
  const top = entries.slice(0, topN).map(e => e[0]);
  const others = entries.slice(topN).map(e => e[0]);
  return { top, others };
}

function histBuildDatasets(chainToUnified, allDates, topChains) {
  const colors = histPrepareColors(topChains.top.length + (topChains.others.length ? 1 : 0));
  const datasets = [];
  let colorIdx = 0;
  for (const chain of topChains.top) {
    const series = chainToUnified[chain] || [];
    datasets.push({
      label: chain,
      data: series.map(p => ({ x: p.t, y: p.v })),
      fill: true,
      borderColor: colors[colorIdx],
      backgroundColor: colors[colorIdx] + '33',
      tension: 0.25,
      pointRadius: 0,
      borderWidth: 1.5,
      stack: 'chains'
    });
    colorIdx++;
  }
  if (topChains.others.length) {
    const summed = allDates.map((t, i) => {
      let v = 0;
      for (const chain of topChains.others) {
        const s = chainToUnified[chain];
        v += s?.[i]?.v || 0;
      }
      return { x: t, y: v };
    });
    datasets.push({
      label: 'Other',
      data: summed,
      fill: true,
      borderColor: colors[colorIdx],
      backgroundColor: colors[colorIdx] + '33',
      tension: 0.25,
      pointRadius: 0,
      borderWidth: 1.5,
      stack: 'chains'
    });
  }
  return datasets;
}

function histBuildTotalSeries(chainToUnified, allDates) {
  return allDates.map((t, i) => {
    let sum = 0;
    for (const series of Object.values(chainToUnified)) {
      sum += series?.[i]?.v || 0;
    }
    return { x: t, y: sum };
  });
}

function histEnsureCharts() {
  const mcCtx = document.getElementById('histMarketCapChart');
  const stCtx = document.getElementById('histStackedChart');
  if (!mcCtx || !stCtx || !window.Chart) return;
  const isMobile = window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
  if (!HIST_marketCapChart) {
    HIST_marketCapChart = new Chart(mcCtx, {
      type: 'line',
      data: { datasets: [] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => histFormatUSD(ctx.parsed.y) } } },
        scales: {
          x: { type: 'time', time: { unit: 'month' }, grid: { color: '#1c2634' }, ticks: { color: 'rgba(255,255,255,0.7)' } },
          y: { stacked: false, grid: { color: '#1c2634' }, ticks: { color: 'rgba(255,255,255,0.7)', callback: (v) => histFormatUSD(v) } }
        }
      }
    });
  }
  if (!HIST_stackedChart) {
    HIST_stackedChart = new Chart(stCtx, {
      type: 'line',
      data: { datasets: [] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: !isMobile, position: 'bottom', labels: { color: 'rgba(255,255,255,0.8)' } }, tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${histFormatUSD(ctx.parsed.y)}` } } },
        scales: {
          x: { type: 'time', time: { unit: 'month' }, grid: { color: '#1c2634' }, ticks: { color: 'rgba(255,255,255,0.7)' } },
          y: { stacked: true, grid: { color: '#1c2634' }, ticks: { color: 'rgba(255,255,255,0.7)', callback: (v) => histFormatUSD(v) } }
        }
      }
    });
  } else {
    // Update legend visibility on re-entry/resizes
    if (HIST_stackedChart?.options?.plugins?.legend) {
      HIST_stackedChart.options.plugins.legend.display = !isMobile;
      HIST_stackedChart.update('none');
    }
  }
}

async function initHistorical() {
  if (historicalInitDone) return;
  historicalInitDone = true;
  const search = document.getElementById('histSearch');
  if (search) search.addEventListener('input', (e) => histFilterAssets(e.target.value));
  try {
    histSetStatus('Loading stablecoin list…');
    const data = await histFetchJSON(HIST_API_LIST);
    HIST_allAssets = (data.peggedAssets || [])
      .map(a => ({ id: a.id, name: a.name, symbol: a.symbol, circulating: a.circulating }))
      .sort((x, y) => (y.circulating?.peggedUSD || 0) - (x.circulating?.peggedUSD || 0));
    HIST_filteredAssets = HIST_allAssets;
    histRenderAssetList();
    histSetStatus('');
    if (HIST_allAssets.length) histSelectAsset(HIST_allAssets[0]);
  } catch (e) {
    console.error(e);
    histSetStatus('Failed to load stablecoin list. ' + e.message, 'error');
  }
}

async function histSelectAsset(asset) {
  try {
    histEnsureCharts();
    histSetStatus(`Loading ${asset.name}…`);
    const nameEl = document.getElementById('histAssetName');
    const symEl = document.getElementById('histAssetSymbol');
    const descEl = document.getElementById('histAssetDesc');
    const circEl = document.getElementById('histCurrentCirc');
    const chainCountEl = document.getElementById('histChainCount');
    const linkEl = document.getElementById('histMarketCapLink');
    if (nameEl) nameEl.textContent = asset.name;
    if (symEl) symEl.textContent = asset.symbol ? `(${asset.symbol})` : '';
    if (descEl) descEl.textContent = '';
    const symOrId = encodeURIComponent(asset.symbol || asset.id || '');
    if (linkEl && symOrId) {
      linkEl.href = `https://stablecoins.llama.fi/stablecoincharts/${symOrId}`;
      linkEl.title = `Open raw data for ${asset.symbol || asset.name}`;
    }
    const data = await histFetchJSON(HIST_API_ASSET(asset.id));

    const currentCircUsd = asset.circulating?.peggedUSD ?? null;
    if (circEl) circEl.textContent = histFormatUSD(currentCircUsd);
    const chainCount = Object.keys(data.chainBalances || {}).length;
    if (chainCountEl) chainCountEl.textContent = String(chainCount);
    if (data.description && descEl) descEl.textContent = data.description;

    const { allDates, chainToUnified } = histBuildTimeIndex(data.chainBalances || {});
    if (!allDates.length) {
      histSetStatus('No historical data available for this asset.', 'error');
      if (HIST_marketCapChart) { HIST_marketCapChart.data.datasets = []; HIST_marketCapChart.update(); }
      if (HIST_stackedChart) { HIST_stackedChart.data.datasets = []; HIST_stackedChart.update(); }
      return;
    }
    const totalSeries = histBuildTotalSeries(chainToUnified, allDates);
    const topChains = histComputeTopChains(chainToUnified, allDates, 8);
    const stackedDatasets = histBuildDatasets(chainToUnified, allDates, topChains);

    if (HIST_marketCapChart) {
      HIST_marketCapChart.data = {
        datasets: [{
          label: 'Market Cap (USD)',
          data: totalSeries,
          borderColor: '#3ea6ff',
          backgroundColor: '#3ea6ff33',
          fill: false,
          tension: 0.2,
          pointRadius: 0,
          borderWidth: 2
        }]
      };
      HIST_marketCapChart.update();
    }

    if (HIST_stackedChart) {
      HIST_stackedChart.data = { datasets: stackedDatasets };
      HIST_stackedChart.update();
    }

    histSetStatus('');
  } catch (e) {
    console.error(e);
    histSetStatus('Failed to load asset data. ' + e.message, 'error');
  }
}
