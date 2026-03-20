const { getOrders } = require('./_lib/bohwk');
const { getOpenConversations, getRepliedPhones } = require('./_lib/superchat');
const { getTodayAppointments, getVictorTasks, getAllJobs } = require('./_lib/hero');
const { analyze } = require('./_lib/analyzer');
const { getAllContacts } = require('./_lib/contacts');
const { matchOrders } = require('./_lib/matcher');

// PLZ → Region Mapping
let PLZ_MAP;
try {
  PLZ_MAP = require('../plz-region-mapping.json');
} catch {
  PLZ_MAP = {};
}

// Techniker-Definition
const TECHNICIANS = {
  nord: [
    { name: 'Ramiz Zoronjic', id: '158931', jobs: 0 },
    { name: 'Nico Koussios', id: '158934', jobs: 0 },
  ],
  ost: [
    { name: 'Adem Dedeic', id: '158932', jobs: 0 },
    { name: 'Nicolai Walczak', id: '158933', jobs: 0 },
  ],
};

// Cache NUR für B&O + Hero (selten ändernd)
let cache = { bohwk: null, hero: null, tasks: null, heroJobs: null, at: 0 };

// Build Hero job index by normalized address
function normalizeAddr(street, zipcode) {
  if (!street) return null;
  return (street + '|' + (zipcode || ''))
    .toLowerCase()
    .replace(/\bstr\b\.?/g, 'straße')
    .replace(/\bstr\.\s*/g, 'straße ')
    .replace(/\s+/g, ' ')
    .trim();
}
const CACHE_TTL = 5 * 60 * 1000;

function getRegion(zipcode) {
  if (!zipcode) return null;
  const plz = String(zipcode).trim();
  if (PLZ_MAP[plz]) return PLZ_MAP[plz].region.toLowerCase();
  return null;
}

function groupByAddress(orders) {
  const groups = new Map();
  for (const order of orders) {
    const key = `${(order.Street || '').trim()}|${(order.Zipcode || '').trim()}`;
    if (!groups.has(key)) {
      groups.set(key, {
        street: (order.Street || '').trim(),
        zipcode: (order.Zipcode || '').trim(),
        city: (order.City || '').trim(),
        region: getRegion(order.Zipcode),
        orders: [],
      });
    }
    groups.get(key).orders.push(order);
  }
  // Sort by order count descending
  return [...groups.values()]
    .filter(g => g.street) // skip empty addresses
    .sort((a, b) => b.orders.length - a.orders.length);
}

function computeTechnicianWorkload(orders) {
  const techs = JSON.parse(JSON.stringify(TECHNICIANS)); // deep clone
  
  // Count open orders per region
  const regionCounts = { nord: 0, ost: 0 };
  for (const order of orders) {
    const region = getRegion(order.Zipcode);
    if (region && regionCounts[region] !== undefined) {
      regionCounts[region]++;
    }
  }
  
  // Distribute evenly among technicians in each region
  for (const region of ['nord', 'ost']) {
    const count = regionCounts[region];
    const techCount = techs[region].length;
    if (techCount > 0) {
      const perTech = Math.floor(count / techCount);
      const remainder = count % techCount;
      techs[region].forEach((t, i) => {
        t.jobs = perTech + (i < remainder ? 1 : 0);
      });
    }
  }
  
  return techs;
}

function getRecommendedTechnician(techs, region) {
  if (!region || !techs[region]) return null;
  const regionTechs = techs[region];
  if (!regionTechs.length) return null;
  // Return the one with fewest jobs
  return regionTechs.reduce((min, t) => t.jobs < min.jobs ? t : min, regionTechs[0]);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  const force = req.query.refresh === '1';
  const now = Date.now();
  const cacheValid = !force && cache.bohwk && (now - cache.at) < CACHE_TTL;

  try {
    // Parallel: Superchat conversations + replied phones + contacts
    const superchatPromise = getOpenConversations();
    const repliedPhonesPromise = getRepliedPhones();
    const contactsPromise = getAllContacts(force);

    // B&O + Hero aus Cache oder neu laden
    let bohwk, hero, tasks, heroJobs;
    if (cacheValid) {
      bohwk = cache.bohwk;
      hero = cache.hero;
      tasks = cache.tasks;
      heroJobs = cache.heroJobs || [];
    } else {
      const [ordersResult, heroResult, tasksResult, heroJobsResult] = await Promise.allSettled([
        getOrders(),
        getTodayAppointments(),
        getVictorTasks(),
        getAllJobs(),
      ]);
      const timestamp = new Date().toISOString();

      if (ordersResult.status === 'fulfilled') {
        bohwk = {
          rawOrders: ordersResult.value,
          lastUpdate: timestamp, error: null
        };
      } else {
        bohwk = { rawOrders: [], lastUpdate: timestamp, error: ordersResult.reason?.message || 'Fehler' };
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

      heroJobs = heroJobsResult.status === 'fulfilled' ? heroJobsResult.value : [];

      cache = { bohwk, hero, tasks, heroJobs, at: now };
    }

    // Build Hero job index by normalized address (most recent non-archived per address)
    const heroJobIndex = new Map();
    for (const job of heroJobs) {
      if (job.status_name === 'Archiviert') continue;
      const key = normalizeAddr(job.address?.street, job.address?.zipcode);
      if (!key) continue;
      const existing = heroJobIndex.get(key);
      if (!existing || (job.start || '') > (existing.start || '')) {
        heroJobIndex.set(key, job);
      }
    }

    // Superchat-Ergebnisse abwarten
    let superchat, contacts, repliedPhones;
    try {
      const [convResult, repliedResult, contactsResult] = await Promise.allSettled([superchatPromise, repliedPhonesPromise, contactsPromise]);
      const conversations = convResult.status === 'fulfilled' ? convResult.value : [];
      repliedPhones = repliedResult.status === 'fulfilled' ? [...repliedResult.value] : [];
      contacts = contactsResult.status === 'fulfilled' ? contactsResult.value : [];
      superchat = { conversations, repliedPhones, lastUpdate: new Date().toISOString(), error: convResult.status === 'rejected' ? convResult.reason?.message : null };
    } catch (err) {
      superchat = { conversations: [], repliedPhones: [], lastUpdate: new Date().toISOString(), error: err.message };
      contacts = [];
      repliedPhones = [];
    }

    // Matching: B&O orders ↔ Superchat contacts
    const allRawOrders = bohwk.rawOrders || [];
    const matchedOrders = matchOrders(allRawOrders, contacts);

    // Enrich with analysis + region + Hero cross-match
    const enrichedOrders = matchedOrders.map(o => {
      const addrKey = normalizeAddr(o.Street, o.Zipcode);
      const heroJob = addrKey ? (heroJobIndex.get(addrKey) || null) : null;
      return {
        ...o,
        _analysis: analyze(o),
        _region: getRegion(o.Zipcode),
        _heroJob: heroJob ? {
          id: heroJob.id,
          title: heroJob.title,
          status: heroJob.status_name,
          type: heroJob.type,
          start: heroJob.start,
          description: heroJob.description || '',
        } : null,
      };
    });

    // Categorize orders
    const needContact = [];
    const contacted = [];
    const inProgress = [];
    const completed = [];

    for (const order of enrichedOrders) {
      const state = order.OrderCurrentState || '';
      if (state.startsWith('06') || state.startsWith('07') || state.startsWith('08')) {
        completed.push(order);
      } else if (state.startsWith('04')) {
        // "04 Erteilt" = offener Auftrag
        if (order._match?.matched) {
          contacted.push(order);
        } else {
          needContact.push(order);
        }
      } else if (order.OrderState === 2 || order.OrderState === 3) {
        inProgress.push(order);
      } else {
        // Default: treat as needContact if it's a new order (OrderState 1)
        if (order.OrderState === 1) {
          if (order._match?.matched) {
            contacted.push(order);
          } else {
            needContact.push(order);
          }
        }
      }
    }

    // Address groups (nur offene Aufträge)
    const openOrders = [...needContact, ...contacted];
    const addressGroups = groupByAddress(openOrders);

    // Technician workload
    const technicians = computeTechnicianWorkload(openOrders);

    // Add recommended technician to needContact orders
    for (const order of needContact) {
      const region = order._region;
      order._recommendedTech = getRecommendedTechnician(technicians, region);
    }

    // Build legacy bohwk format for backward compatibility
    const bohwkCompat = {
      orders: enrichedOrders.filter(o => o.OrderState === 1),
      allOrders: {
        neu: enrichedOrders.filter(o => o.OrderState === 1).length,
        laufend: enrichedOrders.filter(o => o.OrderState === 2).length,
        unterbrochen: enrichedOrders.filter(o => o.OrderState === 3).length,
        fertig: enrichedOrders.filter(o => o.OrderState === 4).length,
      },
      lastUpdate: bohwk.lastUpdate,
      error: bohwk.error,
    };

    res.json({
      orders: {
        needContact,
        contacted,
        inProgress,
        completed,
        all: enrichedOrders,
      },
      addressGroups,
      technicians,
      stats: {
        total: openOrders.length,
        needContact: needContact.length,
        contacted: contacted.length,
        addressGroups: addressGroups.length,
      },
      bohwk: bohwkCompat,
      superchat,
      hero,
      tasks,
      heroStats: {
        total: heroJobs.length,
        byStatus: heroJobs.reduce((acc, j) => { acc[j.status_name] = (acc[j.status_name] || 0) + 1; return acc; }, {}),
        invoicePending: heroJobs.filter(j => j.status_name === 'Rechnung').length,
        emergency: heroJobs.filter(j => j.type === 'emergency' && j.status_name !== 'Archiviert' && j.status_name !== 'Abgeschlossen').length,
        openJobs: heroJobs.filter(j => ['Offen', 'Zugewiesen'].includes(j.status_name)),
      },
      cached: cacheValid,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
