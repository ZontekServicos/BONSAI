import pg from "pg";
import type { Config } from "./config.js";
// DATE has no timezone. NUMERIC keeps pg's default string parser.
pg.types.setTypeParser(1082, (value) => value);
export interface DB {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}
export interface Database extends DB {
  transaction<T>(fn: (db: DB) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export function createDatabase(config: Config) {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.PG_POOL_MAX,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 15000,
    application_name: "bonsai-api",
  });
  pool.on("error", () => {
    console.error("Idle database connection failed");
  });
  const db: Database = {
    query: (sql, values) => pool.query(sql, values),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
  return db;
}
export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  db: DB,
  sql: string,
  values: unknown[] = [],
) {
  return (await db.query<T>(sql, values)).rows[0];
}
export const userColumns = "id, nome, email, role, status, created_at";
export const alunoSQL = `SELECT u.id,u.nome,u.email,u.role,u.status,u.created_at,
  json_build_object('user_id',p.user_id,'numero_matricula',p.numero_matricula,'modalidade',p.modalidade,
    'faixa',p.faixa,'graduacao_nivel',p.graduacao_nivel,'nivel',p.nivel,'total_presencas',p.total_presencas,
    'foto_url',p.foto_url,'altura',p.altura,'peso',p.peso,'medidas_atualizadas_em',p.medidas_atualizadas_em,
    'imc',i.imc,'imc_classificacao',i.classificacao,
    'data_matricula',to_char(p.data_matricula,'YYYY-MM-DD')) AS perfil
  FROM users u JOIN aluno_profile p ON p.user_id=u.id
  CROSS JOIN LATERAL (
    -- IMC = peso (kg) / altura (m)². Arredondado em 1 casa e classificado pelo
    -- MESMO valor arredondado (o número exibido e a faixa nunca divergem).
    -- Faixas OMS para adultos; para menores de 18 a referência é a curva por
    -- idade, então a classificação adulta não é aplicada.
    SELECT r.imc,
           CASE WHEN r.imc IS NULL THEN NULL
                WHEN p.data_nascimento > (fn_hoje_sp() - interval '18 years')::date THEN 'menor_de_idade'
                WHEN r.imc < 18.5 THEN 'abaixo_do_peso'
                WHEN r.imc < 25 THEN 'normal'
                WHEN r.imc < 30 THEN 'sobrepeso'
                ELSE 'obesidade' END AS classificacao
      FROM (SELECT round(p.peso / (p.altura * p.altura), 1) AS imc) r
  ) i`;
