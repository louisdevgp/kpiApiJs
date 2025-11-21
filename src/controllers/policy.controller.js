// controllers/policy.controller.js
const { pool } = require('../lib/db');

/* ==== Utils ==== */
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
  if (typeof v === 'object') return v;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return def; }
  }
  return def;
}
// Champs “de forme” = ceux qui changent la logique de calcul
const SHAPE_KEYS = [
  'use_internet','use_tpe_on','use_geofence','use_battery','use_printer','use_paper',
  'battery_min_pct','daily_fail_N','weekly_fail_days','weekly_fail_slots',
  'slot_hours_json','paper_mode'
];

/* ==== Snapshot helpers ==== */
function normalizeShape(payload) {
  return {
    use_internet: b(payload.use_internet, 1),
    use_tpe_on:   b(payload.use_tpe_on, 1),
    use_geofence: b(payload.use_geofence, 1),
    use_battery:  b(payload.use_battery, 1),
    use_printer:  b(payload.use_printer, 1),
    use_paper:    b(payload.use_paper, 1),
    battery_min_pct: i(payload.battery_min_pct, 20),
    daily_fail_N:    i(payload.daily_fail_N, 1),
    weekly_fail_days:  payload.weekly_fail_days == null ? null : i(payload.weekly_fail_days),
    weekly_fail_slots: payload.weekly_fail_slots == null ? null : i(payload.weekly_fail_slots),
    slot_hours_json:   parseHours(payload.slot_hours_json ?? [12,13,14,15,17,18,19]),
    paper_mode: String(payload.paper_mode ?? 'strict'),
  };
}
function shapeChanged(oldRow, newShape) {
  // Compare champs pertinents (en traitant slot_hours_json comme tableau num trié)
  const A = normalizeShape(oldRow);
  const B = normalizeShape(newShape);
  const same =
    A.use_internet === B.use_internet &&
    A.use_tpe_on   === B.use_tpe_on &&
    A.use_geofence === B.use_geofence &&
    A.use_battery  === B.use_battery &&
    A.use_printer  === B.use_printer &&
    A.use_paper    === B.use_paper &&
    A.battery_min_pct === B.battery_min_pct &&
    (A.weekly_fail_days ?? null)  === (B.weekly_fail_days ?? null) &&
    (A.weekly_fail_slots ?? null) === (B.weekly_fail_slots ?? null) &&
    A.daily_fail_N === B.daily_fail_N &&
    A.paper_mode === B.paper_mode &&
    JSON.stringify(A.slot_hours_json) === JSON.stringify(B.slot_hours_json);
  return !same;
}

/* ==== Version snapshots ==== */
async function insertVersionSnapshot(policyRow) {
  const shape = normalizeShape(policyRow);
  const name  = policyRow.name;
  const status = policyRow.status;
  const { policy_id, current_version } = { policy_id: policyRow.id, current_version: policyRow.current_version };

  await pool.query(
    `INSERT INTO kpi2_policy_version
      (policy_id, version, name, 
       use_internet, use_tpe_on, use_geofence, use_battery, use_printer, use_paper,
       battery_min_pct, daily_fail_N, weekly_fail_days, weekly_fail_slots,
       slot_hours_json, paper_mode, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?)`,
    [
      policy_id, current_version, String(name),
      shape.use_internet, shape.use_tpe_on, shape.use_geofence, shape.use_battery, shape.use_printer, shape.use_paper,
      shape.battery_min_pct, shape.daily_fail_N, shape.weekly_fail_days, shape.weekly_fail_slots,
      JSON.stringify(shape.slot_hours_json), shape.paper_mode, status
    ]
  );
}

async function getCurrentPolicy(id) {
  const [[row]] = await pool.query(
    `SELECT id, name, status, current_version, slot_hours_json,
            use_internet, use_tpe_on, use_geofence, use_battery, use_printer, use_paper,
            battery_min_pct, daily_fail_N, weekly_fail_days, weekly_fail_slots,
            paper_mode, created_at, updated_at
       FROM kpi2_policy WHERE id = ?`,
    [id]
  );
  if (!row) return null;
  row.slot_hours_json = parseJsonSafe(row.slot_hours_json, []);
  return row;
}

/* ==== Handlers ==== */
exports.list = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, name, status, current_version, slot_hours_json,
              use_internet, use_tpe_on, use_geofence, use_battery, use_printer, use_paper,
              battery_min_pct, daily_fail_N, weekly_fail_days, weekly_fail_slots,
              paper_mode, created_at, updated_at
         FROM kpi2_policy
         ORDER BY id DESC`
    );
    const data = rows.map(r => ({ ...r, slot_hours_json: parseJsonSafe(r.slot_hours_json, []) }));
    res.json({ data });
  } catch (err) {
    console.error('policy.list error:', err);
    res.status(500).json({ error: err.message || 'list failed' });
  }
};

exports.get = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await getCurrentPolicy(id);
    if (!row) return res.status(404).json({ error: 'Not found' });

    // option: retourner aussi les versions
    const [versions] = await pool.query(
      `SELECT policy_id, version, status, name, paper_mode, created_at
         FROM kpi2_policy_version
        WHERE policy_id = ?
        ORDER BY version DESC`,
      [id]
    );

    res.json({ data: row, versions });
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
    if (!hours.length) return res.status(400).json({ error: 'slot_hours_json doit contenir des heures 0..23' });

    if (!['draft','active','archived'].includes(String(status))) {
      return res.status(400).json({ error: 'status invalide' });
    }
    if (!['strict','lenient'].includes(String(paper_mode))) {
      return res.status(400).json({ error: 'paper_mode invalide' });
    }

    // version initiale = 1
    const [result] = await pool.query(
      `INSERT INTO kpi2_policy
        (name, status, current_version, slot_hours_json,
         use_internet, use_tpe_on, use_geofence, use_battery, use_printer, use_paper,
         battery_min_pct, daily_fail_N, weekly_fail_days, weekly_fail_slots,
         paper_mode, created_at, updated_at)
       VALUES (?, ?, 1, CAST(? AS JSON),
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
    const row = await getCurrentPolicy(id);

    // snapshot v1
    await insertVersionSnapshot(row);

    res.status(201).json({ data: row });
  } catch (err) {
    console.error('policy.create error:', err);
    res.status(500).json({ error: err.message || 'create failed' });
  }
};

exports.update = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const current = await getCurrentPolicy(id);
    if (!current) return res.status(404).json({ error: 'Not found' });

    const payload = { ...req.body };

    // On sépare les champs visu (name, status) des champs "de forme".
    const shapeCandidate = { ...current, ...payload };
    const willChangeShape = shapeChanged(current, shapeCandidate);

    const fields = [];
    const args   = [];

    // Toujours autoriser name/status
    if (payload.name != null) { fields.push('name = ?'); args.push(String(payload.name)); }
    if (payload.status != null) {
      const s = String(payload.status);
      if (!['draft','active','archived'].includes(s)) {
        return res.status(400).json({ error: 'status invalide' });
      }
      fields.push('status = ?'); args.push(s);
    }

    if (willChangeShape) {
      // Normaliser les "shape" + caster JSON pour slot_hours
      const norm = normalizeShape(shapeCandidate);
      fields.push(
        'use_internet = ?','use_tpe_on = ?','use_geofence = ?','use_battery = ?','use_printer = ?','use_paper = ?',
        'battery_min_pct = ?','daily_fail_N = ?','weekly_fail_days = ?','weekly_fail_slots = ?',
        'slot_hours_json = CAST(? AS JSON)','paper_mode = ?'
      );
      args.push(
        norm.use_internet, norm.use_tpe_on, norm.use_geofence, norm.use_battery, norm.use_printer, norm.use_paper,
        norm.battery_min_pct, norm.daily_fail_N, norm.weekly_fail_days, norm.weekly_fail_slots,
        JSON.stringify(norm.slot_hours_json), norm.paper_mode
      );

      // Incrémenter la version
      fields.push('current_version = current_version + 1');
    }

    if (!fields.length) {
      return res.json({ ok: true, message: 'nothing to update' });
    }

    fields.push('updated_at = NOW()');
    await pool.query(`UPDATE kpi2_policy SET ${fields.join(', ')} WHERE id = ?`, [...args, id]);

    const updated = await getCurrentPolicy(id);

    // Si la forme a changé → snapshot de la nouvelle version
    if (willChangeShape) {
      await insertVersionSnapshot(updated);
    }

    res.json({ data: updated, bumped_version: willChangeShape ? updated.current_version : null });
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
    // Les versions liées sont supprimées via ON DELETE CASCADE
    res.json({ ok: true });
  } catch (err) {
    console.error('policy.remove error:', err);
    res.status(500).json({ error: err.message || 'delete failed' });
  }
};
