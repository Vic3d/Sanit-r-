const https = require('https');

async function graphql(query, variables = {}) {
  const body = JSON.stringify({ query, variables });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'app.hero-software.de',
      path: '/api/graphql',
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
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  const data = await graphql(`
    query($from:String!,$to:String!){
      field_service_jobs(first:50,filter:{scheduled_at_gte:$from,scheduled_at_lte:$to}){
        nodes{id title status scheduled_at description
          contact{name phone}
          address{street city zip}
        }
      }
    }
  `, { from: today, to: tomorrow });
  return (data?.field_service_jobs?.nodes || []).map(j => ({
    id: j.id, title: j.title, status: j.status,
    scheduledAt: j.scheduled_at, description: j.description,
    contact: j.contact?.name || '', phone: j.contact?.phone || '',
    address: j.address ? `${j.address.street}, ${j.address.zip} ${j.address.city}` : '',
  }));
}

async function createJob({ title, address, description, contactName, contactPhone, notes }) {
  const data = await graphql(`
    mutation($input:CreateFieldServiceJobInput!){
      create_field_service_job(input:$input){id title status}
    }
  `, {
    input: {
      title,
      description: `${description}\n\n${notes || ''}`.trim(),
      address: { street: address },
      contact: { name: contactName, phone: contactPhone }
    }
  });
  return data?.create_field_service_job;
}

module.exports = { getTodayAppointments, createJob };
