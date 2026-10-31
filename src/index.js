// A.20 Auditorías internas — API (Cloudflare Worker + Neon)
// Silver Industrial · ISO 9001:2015 · PR.04
// Un solo rol: administrador (clave ADMIN_KEY, la misma del P.07). Cada ítem se guarda por separado:
// dos dispositivos pueden cargar la misma auditoría sin pisarse.

import { neon } from '@neondatabase/serverless';

const DEFAULT_ORIGINS = ['https://diegortizdao-collab.github.io'];
const RESULTADOS = ['C', 'OM', 'HA', 'NC', 'NA'];
const ESTADOS_SEG = ['cerrado', 'abierto', 'no_eficaz'];
const TIPOS = ['NC', 'HA', 'OM'];
const CAMPOS_AUD = ['auditor', 'funcion', 'alcance', 'temas', 'criterios', 'fecha_pedido', 'fecha_programada',
  'fecha_auditoria', 'hora_inicio', 'resumen', 'fecha_informe', 'estado'];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function secret(binding) {
  if (binding == null) return null;
  if (typeof binding === 'string') return binding;
  if (typeof binding.get === 'function') return await binding.get();
  return null;
}

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

async function requireAdmin(req, env) {
  const given = req.headers.get('X-Clave');
  const admin = await secret(env.ADMIN_KEY);
  if (!given || !admin || !(await safeEqual(given, admin))) throw new HttpError(401, 'Clave incorrecta.');
}

function corsHeaders(req, env) {
  const allowed = env.ALLOWED_ORIGINS ? String(env.ALLOWED_ORIGINS).split(',').map(s => s.trim()) : DEFAULT_ORIGINS;
  const origin = req.headers.get('Origin');
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Clave',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  if (origin && allowed.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(req, env, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders(req, env) },
  });
}

async function body(req) {
  try { return await req.json(); } catch { throw new HttpError(400, 'El cuerpo no es JSON válido.'); }
}

const txt = (v, max = 20000) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s.slice(0, max);
};
const int = (v, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `${name} inválido.`);
  return n;
};

async function getAud(sql, id) {
  const r = await sql.query('select * from aud_auditorias where id=$1', [id]);
  if (!r.length) throw new HttpError(404, 'Auditoría inexistente.');
  return r[0];
}

async function handle(req, env, url) {
  const p = url.pathname.replace(/\/+$/, '');
  if (p === '/api/health') return json(req, env, { ok: true });

  await requireAdmin(req, env);
  const sql = neon(await secret(env.DATABASE_URL));
  const m = req.method;
  let g;

  // --- años y programa ---
  if (m === 'GET' && p === '/api/anios') {
    const r = await sql.query('select distinct anio from aud_auditorias order by anio desc');
    return json(req, env, r.map(x => x.anio));
  }

  if (m === 'GET' && p === '/api/programa') {
    const anio = int(url.searchParams.get('anio'), 'Año');
    const r = await sql.query(`
      select pr.codigo, pr.nombre, pr.auditor_tipo, pr.orden,
             a.id, a.nro, a.estado, a.fecha_auditoria, a.auditor,
             (select count(*) from aud_checklist c where c.anio=$1 and c.proceso=pr.codigo)::int as items,
             (select count(*) from aud_resultados r where r.auditoria_id=a.id and r.resultado is not null)::int as hechos,
             (select coalesce(json_object_agg(tipo,n),'{}') from (select tipo,count(*) n from aud_hallazgos h where h.auditoria_id=a.id group by tipo) t) as hallazgos
      from aud_procesos pr
      left join aud_auditorias a on a.proceso=pr.codigo and a.anio=$1
      order by pr.orden`, [anio]);
    return json(req, env, r);
  }

  // --- crear auditoría para un año (copia datos y checklist del último año disponible) ---
  if (m === 'POST' && p === '/api/auditorias') {
    const b = await body(req);
    const anio = int(b.anio, 'Año');
    const proceso = txt(b.proceso, 10);
    const pr = await sql.query('select * from aud_procesos where codigo=$1', [proceso]);
    if (!pr.length) throw new HttpError(400, 'Proceso inexistente.');
    const prev = await sql.query('select * from aud_auditorias where proceso=$1 and anio<$2 order by anio desc limit 1', [proceso, anio]);
    const pv = prev[0] || {};
    const auditor = pr[0].auditor_tipo === 'interno' ? 'Ortiz, Diego Alberto' : (pv.auditor || null);
    const ins = await sql.query(`
      insert into aud_auditorias (anio,nro,proceso,auditor,funcion,alcance,temas,criterios,estado,origen)
      values ($1,$2,$3,$4,$5,$6,$7,$8,'en_curso','app')
      on conflict (anio,nro) do nothing returning *`,
      [anio, pr[0].orden, proceso, auditor, pv.funcion || null, pv.alcance || null, pv.temas || null, pv.criterios || null]);
    if (!ins.length) throw new HttpError(409, 'Ya existe una auditoría con ese número para el año.');
    const ck = await sql.query('select count(*)::int n from aud_checklist where anio=$1 and proceso=$2', [anio, proceso]);
    if (!ck[0].n) {
      await sql.query(`insert into aud_checklist (anio,proceso,orden,pregunta,clausula,guia)
        select $1,proceso,orden,pregunta,clausula,guia from aud_checklist
        where proceso=$2 and anio=(select max(anio) from aud_checklist where proceso=$2 and anio<$1)`, [anio, proceso]);
    }
    return json(req, env, ins[0], 201);
  }

  // --- detalle completo de una auditoría ---
  if (m === 'GET' && (g = p.match(/^\/api\/auditorias\/(\d+)$/))) {
    const a = await getAud(sql, +g[1]);
    const [checklist, resultados, hallazgos, previos] = await Promise.all([
      sql.query('select orden,pregunta,clausula,guia from aud_checklist where anio=$1 and proceso=$2 order by orden', [a.anio, a.proceso]),
      sql.query('select item_orden,resultado,evidencia,redaccion,actualizado_en from aud_resultados where auditoria_id=$1 order by item_orden', [a.id]),
      sql.query('select id,orden,tipo,texto,estado,nc_numero from aud_hallazgos where auditoria_id=$1 order by orden', [a.id]),
      sql.query(`select h.id,h.orden,h.tipo,h.texto,h.estado as estado_actual,h.nc_numero,pa.anio,
                   s.estado as seg_estado, s.evidencia as seg_evidencia
                 from aud_hallazgos h
                 join aud_auditorias pa on pa.id=h.auditoria_id
                 left join aud_seguimiento s on s.hallazgo_id=h.id and s.auditoria_id=$1
                 where pa.proceso=$2 and pa.anio<$3
                   and (pa.anio=$3-1 or h.estado<>'cerrado' or s.auditoria_id is not null)
                 order by pa.anio, h.orden`, [a.id, a.proceso, a.anio]),
    ]);
    return json(req, env, { auditoria: a, checklist, resultados, hallazgos, previos });
  }

  // --- datos del informe (encabezado, resumen, estado) ---
  if (m === 'PATCH' && (g = p.match(/^\/api\/auditorias\/(\d+)$/))) {
    const a = await getAud(sql, +g[1]);
    const b = await body(req);
    const sets = [], vals = [];
    for (const k of CAMPOS_AUD) {
      if (!(k in b)) continue;
      let v = txt(b[k]);
      if ((k === 'fecha_auditoria' || k === 'fecha_informe') && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, `Fecha inválida en ${k}.`);
      if (k === 'estado' && !['programada', 'en_curso', 'emitida'].includes(v)) throw new HttpError(400, 'Estado inválido.');
      vals.push(v); sets.push(`${k}=$${vals.length}`);
    }
    if (!sets.length) return json(req, env, a);
    vals.push(a.id);
    const r = await sql.query(`update aud_auditorias set ${sets.join(',')}, actualizado_en=now() where id=$${vals.length} returning *`, vals);
    return json(req, env, r[0]);
  }

  // --- un ítem del checklist ---
  if (m === 'PUT' && (g = p.match(/^\/api\/auditorias\/(\d+)\/resultados\/(\d+)$/))) {
    const a = await getAud(sql, +g[1]);
    const orden = int(g[2], 'Ítem');
    const b = await body(req);
    const res = txt(b.resultado, 2);
    if (res && !RESULTADOS.includes(res)) throw new HttpError(400, 'Resultado inválido.');
    const r = await sql.query(`
      insert into aud_resultados (auditoria_id,item_orden,resultado,evidencia,redaccion,actualizado_en,actualizado_por)
      values ($1,$2,$3,$4,$5,now(),'app')
      on conflict (auditoria_id,item_orden) do update set resultado=excluded.resultado, evidencia=excluded.evidencia,
        redaccion=excluded.redaccion, actualizado_en=now(), actualizado_por='app'
      returning item_orden,resultado,evidencia,redaccion,actualizado_en`,
      [a.id, orden, res, txt(b.evidencia), txt(b.redaccion, 4000)]);
    await sql.query('update aud_auditorias set actualizado_en=now() where id=$1', [a.id]);
    return json(req, env, r[0]);
  }

  // --- seguimiento de un hallazgo anterior ---
  if (m === 'PUT' && (g = p.match(/^\/api\/auditorias\/(\d+)\/seguimiento\/(\d+)$/))) {
    const a = await getAud(sql, +g[1]);
    const hid = int(g[2], 'Hallazgo');
    const b = await body(req);
    const est = txt(b.estado, 12);
    if (est && !ESTADOS_SEG.includes(est)) throw new HttpError(400, 'Estado de seguimiento inválido.');
    const h = await sql.query('select id from aud_hallazgos where id=$1', [hid]);
    if (!h.length) throw new HttpError(404, 'Hallazgo inexistente.');
    const r = await sql.query(`
      insert into aud_seguimiento (auditoria_id,hallazgo_id,estado,evidencia,actualizado_en) values ($1,$2,$3,$4,now())
      on conflict (auditoria_id,hallazgo_id) do update set estado=excluded.estado, evidencia=excluded.evidencia, actualizado_en=now()
      returning *`, [a.id, hid, est, txt(b.evidencia)]);
    if (est) await sql.query('update aud_hallazgos set estado=$1 where id=$2', [est, hid]);
    return json(req, env, r[0]);
  }

  // --- emitir: fija la lista de hallazgos del informe ---
  if (m === 'POST' && (g = p.match(/^\/api\/auditorias\/(\d+)\/emitir$/))) {
    const a = await getAud(sql, +g[1]);
    const b = await body(req);
    const lista = Array.isArray(b.hallazgos) ? b.hallazgos : [];
    for (const x of lista) if (!TIPOS.includes(x.tipo) || !txt(x.texto)) throw new HttpError(400, 'Hallazgo inválido.');
    const actuales = await sql.query('select orden,nc_numero,estado from aud_hallazgos where auditoria_id=$1', [a.id]);
    const previo = Object.fromEntries(actuales.map(x => [x.orden, x]));
    const stmts = [sql.query('delete from aud_hallazgos where auditoria_id=$1 and id not in (select hallazgo_id from aud_seguimiento)', [a.id])];
    lista.forEach((x, i) => {
      const o = i + 1, pv = previo[o] || {};
      stmts.push(sql.query(`insert into aud_hallazgos (auditoria_id,orden,tipo,texto,estado,nc_numero) values ($1,$2,$3,$4,$5,$6)
        on conflict (auditoria_id,orden) do update set tipo=excluded.tipo, texto=excluded.texto`,
        [a.id, o, x.tipo, txt(x.texto, 4000), pv.estado || 'abierto', pv.nc_numero ?? null]));
    });
    stmts.push(sql.query(`update aud_auditorias set estado='emitida', actualizado_en=now() where id=$1`, [a.id]));
    await sql.transaction(stmts);
    const h = await sql.query('select id,orden,tipo,texto,estado,nc_numero from aud_hallazgos where auditoria_id=$1 order by orden', [a.id]);
    return json(req, env, h);
  }

  // --- vincular un hallazgo con su NC / OM ---
  if (m === 'PATCH' && (g = p.match(/^\/api\/hallazgos\/(\d+)$/))) {
    const b = await body(req);
    const sets = [], vals = [];
    if ('nc_numero' in b) { vals.push(b.nc_numero == null || b.nc_numero === '' ? null : int(b.nc_numero, 'Número de NC')); sets.push(`nc_numero=$${vals.length}`); }
    if ('estado' in b) { if (!ESTADOS_SEG.includes(b.estado)) throw new HttpError(400, 'Estado inválido.'); vals.push(b.estado); sets.push(`estado=$${vals.length}`); }
    if (!sets.length) throw new HttpError(400, 'Nada para actualizar.');
    vals.push(+g[1]);
    const r = await sql.query(`update aud_hallazgos set ${sets.join(',')} where id=$${vals.length} returning *`, vals);
    if (!r.length) throw new HttpError(404, 'Hallazgo inexistente.');
    return json(req, env, r[0]);
  }

  // --- hallazgos para el dashboard (todos los años) ---
  if (m === 'GET' && p === '/api/hallazgos') {
    const [procs, auds, hall] = await Promise.all([
      sql.query('select codigo, nombre, auditor_tipo, orden from aud_procesos order by orden'),
      sql.query('select anio, proceso, estado from aud_auditorias order by anio'),
      sql.query(`select h.id, a.anio, a.proceso, h.tipo, h.texto, h.estado, h.nc_numero
        from aud_hallazgos h join aud_auditorias a on a.id=h.auditoria_id
        join aud_procesos pr on pr.codigo=a.proceso order by a.anio, pr.orden, h.orden`),
    ]);
    return json(req, env, { procesos: procs, auditorias: auds, hallazgos: hall });
  }

  // --- tablero histórico ---
  if (m === 'GET' && p === '/api/tablero') {
    const [porAnio, porProceso, eficacia, abiertos] = await Promise.all([
      sql.query(`select a.anio, count(distinct a.id)::int auditorias,
          count(h.id) filter (where h.tipo='NC')::int nc, count(h.id) filter (where h.tipo='HA')::int ha,
          count(h.id) filter (where h.tipo='OM')::int om
        from aud_auditorias a left join aud_hallazgos h on h.auditoria_id=a.id group by a.anio order by a.anio`),
      sql.query(`select a.anio, pr.codigo, pr.nombre, pr.orden, count(h.id)::int total,
          count(h.id) filter (where h.tipo='NC')::int nc, count(h.id) filter (where h.tipo='HA')::int ha,
          count(h.id) filter (where h.tipo='OM')::int om
        from aud_auditorias a join aud_procesos pr on pr.codigo=a.proceso
        left join aud_hallazgos h on h.auditoria_id=a.id group by a.anio, pr.codigo, pr.nombre, pr.orden order by pr.orden, a.anio`),
      sql.query(`select pa.anio as anio_hallazgo, s.estado, count(*)::int n
        from aud_seguimiento s join aud_hallazgos h on h.id=s.hallazgo_id join aud_auditorias pa on pa.id=h.auditoria_id
        group by pa.anio, s.estado order by pa.anio`),
      sql.query(`select h.id,h.tipo,h.texto,h.estado,h.nc_numero,a.anio,pr.nombre as proceso
        from aud_hallazgos h join aud_auditorias a on a.id=h.auditoria_id join aud_procesos pr on pr.codigo=a.proceso
        where h.estado<>'cerrado' order by a.anio, pr.orden, h.orden`),
    ]);
    return json(req, env, { porAnio, porProceso, eficacia, abiertos });
  }

  throw new HttpError(404, 'Ruta inexistente.');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req, env) });
    try {
      return await handle(req, env, url);
    } catch (e) {
      if (e instanceof HttpError) return json(req, env, { error: e.message }, e.status);
      console.error('A20 error:', e && e.stack || e);
      return json(req, env, { error: 'Error interno. Reintentá en unos segundos.' }, 500);
    }
  },
};
