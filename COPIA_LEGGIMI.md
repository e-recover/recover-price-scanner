# COPIA DI SVILUPPO — "Box per grado"
Branch: `box-per-grado` (creato da `main` @ e899d3a del 01/08/2026). `main` NON va toccato.

## File della copia
| File | Stato | Note |
|---|---|---|
| `server.js` | modificato | identico a main + 2 righe che montano `grades.js` (prima di `app.listen`) + 1 riga di commento in testata |
| `grades.js` | nuovo (radice) | logica box per grado — solo Ninja, cache 30 min |
| `public/gradi.html` | nuovo | pagina "Box per grado" (catalogo letto da index.html) |
| `test/grades.test.js` | nuovo | test offline, zero crediti: `node test/grades.test.js` |
| `public/index.html` | invariato | |

## Endpoint nuovi
- `GET /api/grades?asin=…&domain=8` (`&deep=1` lettura completa, `&force=1` salta cache)
- `POST /api/grades-bulk` `{items:[{asin,domain}], deep, force}` (max 120 ASIN)
- `GET /api/grades-stats` → chiamate Ninja consumate dall'avvio

## Consumo crediti
- Default: 1 chiamata Ninja per ASIN; pagina extra solo se un grado con box non ha offerte in lista.
- "Lettura completa": fino a 3 chiamate/ASIN, solo se spuntata.
- Cache 30 min (env `GRADES_CACHE_MIN`), tetto pagine 3 (env `GRADES_MAX_PAGES`).
- Nessuna chiamata Keepa/SerpApi dal modulo.

## Messa online separata (Render) — senza toccare il servizio principale
1. GitHub → repo → menu branch → scrivi `box-per-grado` → "Create branch from main".
2. Sul branch `box-per-grado`: sostituisci `server.js`, carica `grades.js`, `public/gradi.html`, `test/grades.test.js`, `COPIA_LEGGIMI.md`.
3. Render → New → Web Service → stesso repo → **Branch: box-per-grado** → nome `recover-price-scanner-copia` → Free → Build `npm install` → Start `npm start`.
4. Environment della copia: SOLO `NINJA_KEY`, `BASIC_AUTH_USER`, `BASIC_AUTH_PASS`.
   NON inserire `KEEPA_API_KEY` né `SERPAPI_KEY`: così la copia non consuma Keepa (il job /api/prezzi si salta) né SerpApi.
5. Verifica che il servizio principale abbia ancora Branch = `main`.
6. Test: `https://recover-price-scanner-copia.onrender.com/gradi.html` → Cerca `B0F54GZKP9` → Scansiona (1 chiamata).

## Rollback
Eliminare il servizio Render della copia e il branch `box-per-grado`. `main` resta intatto.
