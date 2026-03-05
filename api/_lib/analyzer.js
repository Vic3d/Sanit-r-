const ESTIMATES = {
  'Gasgeräte':                  { time:'1-2h', min:180, max:450 },
  'Zentrale Heizungsanlage':    { time:'2-4h', min:300, max:800 },
  'Heizungsarbeiten':           { time:'0.5-1.5h', min:80, max:250 },
  'Sanitärarbeiten':            { time:'1-2h', min:120, max:400 },
  'Leichte Sanitärarbeiten':    { time:'0.5-1h', min:60, max:150 },
  'Leckageortung':              { time:'1-3h', min:200, max:600 },
  'default':                    { time:'1-2h', min:100, max:300 },
};

function analyze(order) {
  const est = ESTIMATES[order.Craft] || ESTIMATES['default'];
  const emergency = order.Emergency === 1;
  const dist = order.DisturbanceType || '';
  const isInsurance = dist.includes('02 Versicherung') || dist.includes('07 Versicherung');
  const isForeign = dist.includes('03 Fremdbelastung') || dist.includes('12 Reparatur außerhalb');

  let min = est.min;
  let max = est.max;
  if (emergency) { min = Math.round(min * 1.25); max = Math.round(max * 1.25); }
  if (isInsurance) { min = Math.round(min * 1.3); max = Math.round(max * 1.3); }

  const notes = [];
  if (emergency) notes.push('⚡ NOTFALL');
  if (isInsurance) notes.push('📋 Versicherungsfall – Doku wichtig');
  if (isForeign) notes.push('👤 Fremdbelastung / Außerpauschal – Vollrechnung prüfen');
  if (order.Remarks?.toLowerCase().includes('kein ww')) notes.push('🚿 Kein Warmwasser');
  if (order.Remarks?.includes('TRGS')) notes.push('☣️ Schadstoff möglich');

  const priority = emergency ? 'HOCH' : (isInsurance || isForeign ? 'MITTEL' : 'NORMAL');

  return { priority, time: est.time, priceRange: `${min}–${max}€`, priceMin: min, priceMax: max, notes, emergency };
}

module.exports = { analyze };
