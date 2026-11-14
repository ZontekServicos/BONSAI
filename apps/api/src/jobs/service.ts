import type { Database } from "../db.js";
import { one } from "../db.js";
import type { Config } from "../config.js";
import { batch } from "../modules/billing.js";
export async function daily(db: Database, config: Config) {
  return db.transaction(async (tx) => {
    const lock = await one(tx, "SELECT pg_try_advisory_xact_lock(72106402) AS locked");
    if (!lock.locked) return { skipped: true };
    // Match user -> financial lock ordering used by every request.
    await tx.query("SELECT id FROM users WHERE role='aluno' ORDER BY id FOR UPDATE");
    const status = await one(tx, "SELECT * FROM fn_processar_inadimplencia($1)", [
      config.DIAS_CARENCIA,
    ]);
    const presence = await one(tx, "SELECT fn_fechar_presencas_abandonadas(4) AS fechadas");
    await tx.query("DELETE FROM refresh_tokens WHERE expires_at<now()-interval '7 days'");
    await tx.query("DELETE FROM idempotency_keys WHERE expires_at<now()");
    await tx.query("DELETE FROM api_rate_limits WHERE window_start<now()-interval '1 day'");
    let billing;
    if (config.BILLING_ENABLED) {
      const calendar = await one(
        tx,
        "SELECT to_char(fn_hoje_sp(),'YYYY-MM') AS atual,to_char(fn_hoje_sp()+interval '1 month','YYYY-MM') AS seguinte,extract(day FROM fn_hoje_sp())::int AS dia",
      );
      // Catch-up after missed runs, plus next month on/after the 25th.
      billing = await batch(tx, {
        competencia: calendar.atual,
        dia_vencimento: config.BILLING_DUE_DAY,
        valor_padrao: config.BILLING_AMOUNT,
      });
      if (calendar.dia >= 25)
        await batch(tx, {
          competencia: calendar.seguinte,
          dia_vencimento: config.BILLING_DUE_DAY,
          valor_padrao: config.BILLING_AMOUNT,
        });
      await tx.query("SELECT * FROM fn_processar_inadimplencia($1)", [config.DIAS_CARENCIA]);
    }
    return { skipped: false, ...status, ...presence, billing };
  });
}
