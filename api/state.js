const { getOrders } = require('./_lib/bohwk');
const { getOpenConversations, checkAndResetInvalid } = require('./_lib/superchat');
const { getTodayAppointments } = require('./_lib/hero');
const { analyze } = require('./_lib/analyzer');

// Cache für den State (überlebt Lambda-Warmstart)
let cache = { data: null, at: 0 };
const CACHE_TTL = 5 * 60 * 1000; // 5 Minuten

async function buildState() {
  const results = await Promise.allSettled([
    getOrders(),
    getOpenConversations(),
    getTodayAppointments(),
  ]);

  const [ordersResult, superchatResult, heroResult] = results;
  const now = new Date().toISOString();

  // B&O Aufträge
  let bohwk = { orders: [], allOrders: {}, lastUpdate: now, error: null };
  if (ordersResult.status === 'fulfilled') {
    const all = ordersResult.value;
    const newOrders = all.filter(o => o.OrderState === 1).map(o => ({ ...o, _analysis: analyze(o) }));
    bohwk = {
      orders: newOrders,
      allOrders: {
        neu: newOrders.length,
        laufend: all.filter(o => o.OrderState === 2).length,
        unterbrochen: all.filter(o => o.OrderState === 3).length,
        fertig: all.filter(o => o.OrderState === 4).length,
      },
      lastUpdate: now, error: null
    };
  } else {
    bohwk.error = ordersResult.reason?.message || 'Unbekannter Fehler';
  }

  // Superchat
  let superchat = { conversations: [], lastUpdate: now, error: null };
  if (superchatResult.status === 'fulfilled') {
    superchat.conversations = superchatResult.value;
  } else {
    superchat.error = superchatResult.reason?.message || 'Fehler';
  }

  // Hero
  let hero = { appointments: [], lastUpdate: now, error: null };
  if (heroResult.status === 'fulfilled') {
    hero.appointments = heroResult.value;
  } else {
    hero.error = heroResult.reason?.message || 'Fehler';
  }

  return { bohwk, superchat, hero };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const force = req.query.refresh === '1' || checkAndResetInvalid();

  if (!force && cache.data && (Date.now() - cache.at) < CACHE_TTL) {
    return res.json({ ...cache.data, cached: true });
  }

  try {
    const state = await buildState();
    cache = { data: state, at: Date.now() };
    res.json(state);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
