const https = require('https');

const API_KEY = process.env.HERO_API_KEY || 'ac_zr8U50hpotlbK9RENAcGOkUX94YGGaHw';

function gql(query) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ query });
    const req = https.request({
      hostname: 'app.hero-software.de', path: '/api/graphql', method: 'POST',
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ raw: d.slice(0, 200) }); } });
    });
    req.on('error', e => resolve({ error: e.message }));
    req.write(body); req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const results = {};

  const queries = {
    jobs_extended: `{ field_service_jobs(first:1){ nodes{
      id title status scheduled_at description duration priority tags
      contact{name phone email} address{street city zip}
      assignees{id name email} created_at updated_at
    }}}`,
    customers: `{ customers(first:2){ nodes{ id name email phone address{street city zip} }}}`,
    employees: `{ employees(first:5){ nodes{ id name email }}}`,
    invoices: `{ invoices(first:1){ nodes{ id status total_amount due_date }}}`,
    time_entries: `{ time_entries(first:1){ nodes{ id duration started_at }}}`,
    quotes: `{ quotes(first:1){ nodes{ id status total_amount }}}`,
    schema: `{ __schema { queryType { fields { name } } } }`,
  };

  for (const [key, query] of Object.entries(queries)) {
    results[key] = await gql(query);
  }

  res.json(results);
};
