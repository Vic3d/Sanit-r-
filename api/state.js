const { getOrders } = require('./_lib/bohwk');
const { getOpenConversations } = require('./_lib/superchat');
const { getTodayAppointments, getVictorTasks } = require('./_lib/hero');
const { analyze } = require('./_lib/analyzer');

// Cache NUR für B&O + Hero (selten ändernd)
// Superchat wird IMMER frisch geladen (Cursor-Cache macht es schnell)
let cache = { bohwk: null, hero: null, tasks: null, at: 0 };
const CACHE_TTL = 5 * 60 * 1000; // 5 Minuten für B&O/Hero


module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const force = req.query.refresh === '1';
  const now = Date.now();
  const cacheValid = !force && cache.bohwk && (now - cache.at) < CACHE_TTL;

  try {
    // Superchat IMMER frisch (Cursor-Cache macht es schnell, ~1-2 API-Calls)
    const superchatPromise = getOpenConversations();

    // B&O + Hero aus Cache oder neu laden
    let bohwk, hero, tasks;
    if (cacheValid) {
      bohwk = cache.bohwk;
      hero = cache.hero;
      tasks = cache.tasks;
    } else {
      const [ordersResult, heroResult, tasksResult] = await Promise.allSettled([
        getOrders(),
        getTodayAppointments(),
        getVictorTasks(),
      ]);
      const timestamp = new Date().toISOString();

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
          lastUpdate: timestamp, error: null
        };
      } else {
        bohwk = { orders: [], allOrders: {}, lastUpdate: timestamp, error: ordersResult.reason?.message || 'Fehler' };
      }

      if (heroResult.status === 'fulfilled') {
        hero = { appointments: heroResult.value, lastUpdate: timestamp, error: null };
      } else {
        hero = { appointments: [], lastUpdate: timestamp, error: heroResult.reason?.message || 'Fehler' };
      }

      if (tasksResult.status === 'fulfilled') {
        tasks = { items: tasksResult.value, lastUpdate: timestamp, error: null };
      } else {
        tasks = { items: [], lastUpdate: timestamp, error: tasksResult.reason?.message || 'Fehler' };
      }

      cache = { bohwk, hero, tasks, at: now };
    }

    // Superchat-Ergebnis abwarten
    let superchat;
    try {
      const conversations = await superchatPromise;
      superchat = { conversations, lastUpdate: new Date().toISOString(), error: null };
    } catch (err) {
      superchat = { conversations: [], lastUpdate: new Date().toISOString(), error: err.message };
    }

    res.json({ bohwk, superchat, hero, tasks, cached: cacheValid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
