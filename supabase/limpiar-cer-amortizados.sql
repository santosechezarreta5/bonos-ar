-- Borra del histórico reconstruido los CER que ya empezaron a amortizar.
--
-- Correr en Supabase → SQL Editor, con tu usuario admin.
--
-- Por qué: el backfill del 2025-2026 valuó TX26, TX28 y DICP con los cierres de
-- BYMA, y para un CER que ya pagó cuotas de capital ese precio no reconcilia con
-- el capital residual que calcula la app. Las tasas que salieron son imposibles:
-- TX26 llegó a 1,3e13% y TX28 quedó en torno al 48% real sostenido, cuando la
-- curva CER de esas mismas ruedas estaba entre 5% y 20%.
--
-- No está determinado cuál de los dos lados está expresado en otra base, así que
-- se saca el dato en vez de dejarlo. Un punto imposible en el gráfico arruina la
-- escala de toda la serie, y peor: parece un dato.
--
-- Los otros 27 bonos CER no amortizaron todavía y su histórico queda intacto.
-- Las filas del snapshot diario (desde 2026-09-02) también quedan: esas se
-- tomaron con precios en vivo y dan valores sanos.

-- 1) Ver qué se va a borrar, antes de borrar
select ticker,
       count(*)                as filas,
       min(snapshot_date)      as desde,
       max(snapshot_date)      as hasta,
       round(min(tir)::numeric, 2) as tir_min,
       round(max(tir)::numeric, 2) as tir_max
  from public.bond_price_snapshots
 where sector = 'CER'
   and ticker in ('TX26', 'TX28', 'DICP')
   and snapshot_date < '2026-09-02'
 group by ticker
 order by ticker;

-- 2) Borrar
delete from public.bond_price_snapshots
 where sector = 'CER'
   and ticker in ('TX26', 'TX28', 'DICP')
   and snapshot_date < '2026-09-02';

-- 3) Confirmar que no quedó ninguna tasa fuera de escala
select sector,
       count(*)                    as filas,
       round(min(tir)::numeric, 2) as tir_min,
       round(max(tir)::numeric, 2) as tir_max
  from public.bond_price_snapshots
 group by sector
 order by sector;
