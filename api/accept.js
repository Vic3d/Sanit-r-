const { getOrders } = require('./_lib/bohwk');
const { createJob } = require('./_lib/hero');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id fehlt' });

  try {
    const orders = await getOrders();
    const order = orders.find(o => String(o.ID?.SourceId) === String(id));
    if (!order) return res.status(404).json({ error: 'Auftrag nicht gefunden' });

    const heroJob = await createJob({
      title: `B&O: ${order.DisturbanceType} – ${order.Inventory || order.Craft}`,
      address: `${order.Street}, ${order.Zipcode} ${order.City}`,
      description: order.Remarks || '',
      contactName: order.Renter || '',
      contactPhone: (order.Telephone || '').replace(/^-/, ''),
      notes: `B&O Auftrag #${order.ID.SourceId} | Gewerk: ${order.Craft}`
    });

    res.json({ ok: true, heroJob });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
