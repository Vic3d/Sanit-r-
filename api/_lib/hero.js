const https = require('https');

async function graphql(query, variables = {}) {
  const body = JSON.stringify({ query, variables });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'login.hero-software.de',  // Korrekte Domain
      path: '/Api/graphql',               // Korrekte Groß-/Kleinschreibung
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.HERO_API_KEY || 'ac_zr8U50hpotlbK9RENAcGOkUX94YGGaHw'}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data).data || {}); }
        catch { resolve({}); }
      });
    });
    req.on('error', () => resolve({}));
    req.write(body);
    req.end();
  });
}

async function getTodayAppointments() {
  const today = new Date().toISOString().split('T')[0];

  const data = await graphql(`{
    field_service_jobs {
      id title start end type description
      contact { id first_name last_name phone_home phone_mobile email }
      address { street city country { name } }
      customer { id full_name company_id }
    }
  }`);

  const jobs = data?.field_service_jobs || [];

  // Nur heutige Jobs (UTC-Datum vergleichen)
  return jobs
    .filter(j => (j.start || '').startsWith(today))
    .sort((a, b) => (a.start || '').localeCompare(b.start || ''))
    .map(j => ({
      id: j.id,
      title: j.title || j.type || 'Einsatz',
      type: j.type,
      start: j.start,
      end: j.end,
      description: j.description || '',
      contact: [j.contact?.first_name, j.contact?.last_name].filter(Boolean).join(' ') || '',
      phone: j.contact?.phone_mobile || j.contact?.phone_home || '',
      email: j.contact?.email || '',
      customer: j.customer?.full_name || '',
      address: j.address ? `${j.address.street}, ${j.address.city}` : '',
    }));
}

module.exports = { getTodayAppointments };
