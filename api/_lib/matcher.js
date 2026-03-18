/**
 * matcher.js — Matching zwischen B&O Aufträgen und Superchat Kontakten
 * 
 * Matching-Regeln:
 * 1. Superchat contact custom_attribute "Auftragsnummer" === B&O SourceId
 * 2. Normalisierte Telefonnummer des B&O Auftrags === Superchat contact phone handle
 */

/**
 * Bekannte Hausverwaltungs-/Hotline-Prefixes — KEINE Mieter-Nummern
 * Diese werden aus dem Matching und dem "Anschreiben"-Tab herausgefiltert
 */
const BLOCKED_PREFIXES = [
  '+4921174070',  // LEG Hausverwaltung Düsseldorf (0211-74070-xxxx)
  '+493122025',   // weiteres Verwaltungsamt
];

function isBlockedPhone(phone) {
  if (!phone) return false;
  return BLOCKED_PREFIXES.some(prefix => phone.startsWith(prefix));
}

/**
 * Normalisiert eine einzelne Telefonnummer ins +49-Format
 */
function normalizeSinglePhone(raw) {
  if (!raw) return null;
  
  // Alle nicht-Ziffern entfernen (außer + am Anfang)
  let num = raw.trim();
  const hasPlus = num.startsWith('+');
  num = num.replace(/[^\d]/g, '');
  if (!num || num.length < 4) return null;
  
  if (hasPlus) {
    return '+' + num;
  }
  
  // Starts with 0 → replace with +49
  if (num.startsWith('0')) {
    return '+49' + num.substring(1);
  }
  
  // Starts with 49 → add +
  if (num.startsWith('49') && num.length >= 10) {
    return '+' + num;
  }
  
  // Andere Fälle: assume deutsche Nummer ohne Vorwahl-Prefix
  return '+49' + num;
}

/**
 * Extrahiert und normalisiert ALLE Telefonnummern aus einem B&O Telephone-Feld
 * B&O-Nummern können chaotisch sein: "02373-64646 01709950736", "-015229567694", etc.
 */
function normalizePhones(telephone) {
  if (!telephone || telephone === '-' || telephone.trim() === '') return [];
  
  const normalized = [];
  const parts = telephone.split(/\s+/).filter(Boolean);
  
  // Prüfe ob mehrere eigenständige Nummern vorliegen
  // (z.B. "02373-64646 01709950736" — zwei Nummern die jeweils mit 0 starten oder lang genug sind)
  const looksLikeMultiple = parts.length > 1 && parts.filter(p => {
    const digits = p.replace(/[^\d]/g, '');
    return digits.length >= 6 && (p.replace(/^-/, '').match(/^0/) || digits.startsWith('49'));
  }).length > 1;

  if (looksLikeMultiple) {
    // Mehrere separate Nummern
    for (const part of parts) {
      const n = normalizeSinglePhone(part);
      if (n && n.length >= 10) {
        normalized.push(n);
      }
    }
  } else {
    // Eine einzelne Nummer (evtl. mit Leerzeichen formatiert: "49 163 7043664")
    const wholeNorm = normalizeSinglePhone(telephone);
    if (wholeNorm && wholeNorm.length >= 10) {
      normalized.push(wholeNorm);
    }
  }
  
  return [...new Set(normalized)]; // Deduplizieren
}

/**
 * Baut einen Lookup-Index aus Superchat-Kontakten
 */
function buildContactIndex(contacts) {
  const byPhone = new Map();      // normalisierte Telefonnummer → contact
  const byOrderNum = new Map();   // Auftragsnummer → contact
  
  for (const contact of contacts) {
    // Phone handles indexieren
    if (contact.handles) {
      for (const handle of contact.handles) {
        if (handle.type === 'phone' && handle.value) {
          const norm = normalizeSinglePhone(handle.value);
          if (norm) byPhone.set(norm, contact);
        }
      }
    }
    
    // Custom attribute "Auftragsnummer" indexieren (custom_attributes ist ein Array!)
    if (Array.isArray(contact.custom_attributes)) {
      const attr = contact.custom_attributes.find(a => a.name === 'Auftragsnummer');
      if (attr && attr.value != null) {
        byOrderNum.set(String(Math.floor(attr.value)), contact);
      }
    }
  }
  
  return { byPhone, byOrderNum };
}

/**
 * Extrahiert Telefonnummern aus beliebigen Textfeldern (Remarks, StateRemarks etc.)
 * Unterstützt explizite Labels wie "Telefon: +49..." und "T:0211..." und "M:0157..."
 */
function extractPhonesFromText(text) {
  if (!text || typeof text !== 'string') return [];
  const phones = [];
  
  // 1. Explizit gelabelte Nummern: "Telefon: +49...", "T:0211...", "M:0157..."
  const labeledPatterns = [
    /(?:Telefon|Tel|Fon|Phone|T|M)\s*[:\s]\s*(\+?\d[\d\s/\-().]{5,18})/gi,
  ];
  for (const pattern of labeledPatterns) {
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const n = normalizeSinglePhone(m[1]);
      if (n && n.length >= 12) phones.push(n);
    }
  }
  
  // 2. Freistehende Nummern: +49..., 0049..., 0...
  const genericMatches = text.match(/(?:\+49|0049|(?<!\d)49(?=\d)|(?<!\d)0)[\d\s/\-().]{7,18}/g);
  if (genericMatches) {
    for (const m of genericMatches) {
      const n = normalizeSinglePhone(m);
      if (n && n.length >= 12) phones.push(n);
    }
  }
  
  return [...new Set(phones)].filter(p => !isBlockedPhone(p));
}

/**
 * Sammelt ALLE Telefonnummern eines Auftrags (Telephone + Remarks + StateRemarks)
 */
function getAllOrderPhones(order) {
  const phones = new Set();
  
  // 1. Telephone-Feld (Hauptquelle)
  if (order.Telephone) {
    for (const p of normalizePhones(order.Telephone)) phones.add(p);
  }
  
  // 2. Remarks (Beschreibungstext — enthält oft Handynummern)
  if (order.Remarks) {
    for (const p of extractPhonesFromText(order.Remarks)) phones.add(p);
  }
  
  // 3. StateRemarks (Bearbeitungsnotizen)
  if (order.StateRemarks) {
    for (const p of extractPhonesFromText(order.StateRemarks)) phones.add(p);
  }
  
  // 4. Telephone2 (selten, aber möglich)
  if (order.Telephone2) {
    for (const p of normalizePhones(order.Telephone2)) phones.add(p);
  }

  // 5. CustomerContactPerson — Hausmeister-Nummern: "HM: Name T:0211... M:0157..."
  if (order.CustomerContactPerson) {
    for (const p of extractPhonesFromText(order.CustomerContactPerson)) phones.add(p);
  }

  // Geblockte Prefixes (Hausverwaltung, Hotlines) rausfiltern
  return [...phones].filter(p => !isBlockedPhone(p));
}

/**
 * Matched B&O Orders mit Superchat Kontakten
 * @param {Array} orders - B&O Aufträge
 * @param {Array} contacts - Superchat Kontakte
 * @returns {Array} orders mit _match Property
 */
function matchOrders(orders, contacts) {
  const index = buildContactIndex(contacts);
  
  return orders.map(order => {
    const sourceId = order.ID?.SourceId ? String(order.ID.SourceId) : null;
    let matchedContact = null;
    let matchReason = null;
    
    // Match 1: Auftragsnummer
    if (sourceId && index.byOrderNum.has(sourceId)) {
      matchedContact = index.byOrderNum.get(sourceId);
      matchReason = 'auftragsnummer';
    }
    
    // Match 2: Telefonnummern (alle Felder: Telephone + Remarks + StateRemarks)
    if (!matchedContact) {
      const allPhones = getAllOrderPhones(order);
      for (const phone of allPhones) {
        if (index.byPhone.has(phone)) {
          matchedContact = index.byPhone.get(phone);
          matchReason = 'phone';
          break;
        }
      }
    }
    
    return {
      ...order,
      _allPhones: getAllOrderPhones(order),
      _match: {
        matched: !!matchedContact,
        reason: matchReason,
        superchatContact: matchedContact ? {
          id: matchedContact.id,
          firstName: matchedContact.first_name || '',
          lastName: matchedContact.last_name || '',
          phone: matchedContact.handles?.find(h => h.type === 'phone')?.value || '',
        } : null,
      }
    };
  });
}

module.exports = { matchOrders, normalizePhones, normalizeSinglePhone, getAllOrderPhones };
