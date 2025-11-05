// controllers/policy.controller.js
const { pool } = require('../lib/db');

// ===== Utils =====
function b(v, def = 0) {
  if (v === true || v === 1 || v === '1' || v === 'true') return 1;
  if (v === false || v === 0 || v === '0' || v === 'false') return 0;
  return def;
}
function i(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function parseHours(arr) {
  const A = Array.isArray(arr) ? arr : [];
  const unique = [...new Set(A.map(Number))].filter(n => Number.isFinite(n) && n >= 0 && n <= 23);
  unique.sort((a,b)=>a-b);
  return unique;
}
function parseJsonSafe(v, def = []) {
  if (v == null) return def;
  if (Array.isArray(v)) return v;
  if (typeof v === 'object') return v; // mysql2 peut déjà parser JSON
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return def; }
  }
  return def;
}

// ===== Handlers =====
exports.list = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, name, status, slot_hours_json,
              use_internet, use_tpe_on, use_geofence, use_battery, use_printer, use_paper,
              battery_min_pct, daily_fail_N, weekly_fail_days, weekly_fail_slots,
              paper_mode, created_at, updated_at
         FROM kpi2_policy
         ORDER BY id DESC`
    );

    const data = rows.map(r => ({
      ...r,
      slot_hours_json: parseJsonSafe(r.slot_hours_json, []),
    }));

    res.json({ data });
  } catch (err) {
    console.error('policy.list error:', err);
    res.status(500).json({ error: err.message || 'list failed' });
  }
};

exports.get = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [[row]] = await pool.query(
      `SELECT id, name, status, slot_hours_json,
              use_internet, use_tpe_on, use_geofence, use_battery, use_printer, use_paper,
              battery_min_pct, daily_fail_N, weekly_fail_days, weekly_fail_slots,
              paper_mode, created_at, updated_at
         FROM kpi2_policy WHERE id = ?`,
      [id]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });

    row.slot_hours_json = parseJsonSafe(row.slot_hours_json, []);
    res.json({ data: row });
  } catch (err) {
    console.error('policy.get error:', err);
    res.status(500).json({ error: err.message || 'get failed' });
  }
};

exports.create = async (req, res) => {
  try {
    const {
      name = '',
      status = 'draft',
      slot_hours_json = [12,13,14,15,17,18,19],
      use_internet = 1,
      use_tpe_on = 1,
      use_geofence = 1,
      use_battery = 1,
      use_printer = 1,
      use_paper = 1,
      battery_min_pct = 20,
      daily_fail_N = 1,
      weekly_fail_days = 1,
      weekly_fail_slots = 6,
      paper_mode = 'strict',
    } = req.body || {};

    const hours = parseHours(slot_hours_json);
    if (!hours.length) {
      return res.status(400).json({ error: 'slot_hours_json doit contenir des heures 0..23' });
    }

    const validStatus = new Set(['draft','active','archived']);
    if (!validStatus.has(String(status))) {
      return res.status(400).json({ error: 'status invalide' });
    }

    const validPaperMode = new Set(['strict','lenient']);
    if (!validPaperMode.has(String(paper_mode))) {
      return res.status(400).json({ error: 'paper_mode invalide' });
    }

    const [result] = await pool.query(
      `INSERT INTO kpi2_policy
        (name, status, slot_hours_json,
         use_internet, use_tpe_on, use_geofence, use_battery, use_printer, use_paper,
         battery_min_pct, daily_fail_N, weekly_fail_days, weekly_fail_slots,
         paper_mode, created_at, updated_at)
       VALUES (?, ?, CAST(? AS JSON),
               ?, ?, ?, ?, ?, ?,
               ?, ?, ?, ?,
               ?, NOW(), NOW())`,
      [
        String(name), String(status), JSON.stringify(hours),
        b(use_internet), b(use_tpe_on), b(use_geofence), b(use_battery), b(use_printer), b(use_paper),
        i(battery_min_pct,20), i(daily_fail_N,1), i(weekly_fail_days,1), i(weekly_fail_slots,6),
        String(paper_mode)
      ]
    );

    const id = result.insertId;
    const [[row]] = await pool.query(`SELECT * FROM kpi2_policy WHERE id = ?`, [id]);
    row.slot_hours_json = parseJsonSafe(row.slot_hours_json, hours);
    res.status(201).json({ data: row });
  } catch (err) {
    console.error('policy.create error:', err);
    res.status(500).json({ error: err.message || 'create failed' });
  }
};

exports.update = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [[exists]] = await pool.query(`SELECT id FROM kpi2_policy WHERE id = ?`, [id]);
    if (!exists) return res.status(404).json({ error: 'Not found' });

    const payload = { ...req.body };
    const fields = [];
    const args   = [];

    if (payload.name != null) {
      fields.push('name = ?'); args.push(String(payload.name));
    }
    if (payload.status != null) {
      const s = String(payload.status);
      if (!['draft','active','archived'].includes(s)) {
        return res.status(400).json({ error: 'status invalide' });
      }
      fields.push('status = ?'); args.push(s);
    }
    if (payload.slot_hours_json != null) {
      const hours = parseHours(payload.slot_hours_json);
      if (!hours.length) {
        return res.status(400).json({ error: 'slot_hours_json doit contenir des heures 0..23' });
      }
      fields.push('slot_hours_json = CAST(? AS JSON)'); args.push(JSON.stringify(hours));
    }

    ['use_internet','use_tpe_on','use_geofence','use_battery','use_printer','use_paper'].forEach(k => {
      if (payload[k] != null) { fields.push(`${k} = ?`); args.push(b(payload[k])); }
    });

    ['battery_min_pct','daily_fail_N','weekly_fail_days','weekly_fail_slots'].forEach(k => {
      if (payload[k] != null) { fields.push(`${k} = ?`); args.push(i(payload[k])); }
    });

    if (payload.paper_mode != null) {
      const pm = String(payload.paper_mode);
      if (!['strict','lenient'].includes(pm)) {
        return res.status(400).json({ error: 'paper_mode invalide' });
      }
      fields.push('paper_mode = ?'); args.push(pm);
    }

    if (!fields.length) return res.json({ ok: true, message: 'nothing to update' });

    fields.push('updated_at = NOW()');
    await pool.query(
      `UPDATE kpi2_policy SET ${fields.join(', ')} WHERE id = ?`,
      [...args, id]
    );

    const [[row]] = await pool.query(`SELECT * FROM kpi2_policy WHERE id = ?`, [id]);
    row.slot_hours_json = parseJsonSafe(row.slot_hours_json, []);
    res.json({ data: row });
  } catch (err) {
    console.error('policy.update error:', err);
    res.status(500).json({ error: err.message || 'update failed' });
  }
};

exports.remove = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [result] = await pool.query(`DELETE FROM kpi2_policy WHERE id = ?`, [id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('policy.remove error:', err);
    res.status(500).json({ error: err.message || 'delete failed' });
  }
};
