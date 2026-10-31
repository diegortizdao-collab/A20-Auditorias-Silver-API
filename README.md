# A.20 Auditorías internas · API (Cloudflare Worker + Neon)

Backend de la app `A20-Auditorias-Silver-Industrial`. Usa la base de Neon del proyecto **Silver No Conformidades** (tablas `aud_*`).
Desarrollado por Mgter. Diego Ortiz — Líder de Mejora Continua | Consultor ISO

## Tablas (ya creadas y cargadas con 2025 y 2026)
- `aud_procesos` (13 procesos), `aud_checklist` (versionado por año), `aud_auditorias`, `aud_resultados` (una fila por ítem),
  `aud_hallazgos` (con `nc_numero` para vincular con la NC/OM), `aud_seguimiento` (verificación de hallazgos anteriores).
- Esquema en `db/schema.sql`.

## Despliegue
Igual que `P07-Moldes-Silver-API`: usa los secrets del **Secrets Store** `ADMIN_KEY` y `DATABASE_URL` (declarados en `wrangler.toml`).
Conectar este repo en Cloudflare › Workers & Pages › Create › Import a repository. Al desplegar, probar
`https://a20-auditorias-silver-api.<subdominio>.workers.dev/api/health` → `{"ok":true}`.

## Endpoints (todos con cabecera `X-Clave` = ADMIN_KEY, salvo /api/health)
- `GET /api/anios` · `GET /api/programa?anio=2026` · `GET /api/tablero` · `GET /api/hallazgos` (dashboard)
- `POST /api/auditorias` {anio, proceso} — crea la auditoría del año copiando datos y checklist del último año
- `GET|PATCH /api/auditorias/:id`
- `PUT /api/auditorias/:id/resultados/:orden` {resultado, evidencia, redaccion}
- `PUT /api/auditorias/:id/seguimiento/:hallazgoId` {estado, evidencia}
- `POST /api/auditorias/:id/emitir` {hallazgos:[{tipo, texto}]}
- `PATCH /api/hallazgos/:id` {nc_numero, estado}
