import pg from "pg";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || new URL(connectionString).pathname !== "/bonsai_test")
  throw new Error("Dedicated test database required");
const client = new pg.Client({ connectionString });
const schema = `bonsai_perf_${randomUUID().replaceAll("-", "")}`;
await client.connect();
try {
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path=${schema},public`);
  for (const path of [
    "database/schema.sql",
    "database/migrations/0002_runtime.sql",
    "database/migrations/0003_search.sql",
    "database/migrations/0004_papeis_modalidades.sql",
    "database/migrations/0005_cadastro_aluno.sql",
    "database/migrations/0006_ajustes_ficha_professor.sql",
    "database/migrations/0007_convites.sql",
    "database/migrations/0008_perfil_aluno.sql",
  ])
    await client.query(await readFile(path, "utf8"));
  await client.query(`INSERT INTO users(nome,email,password_hash,role)
    SELECT 'Aluno '||n, 'aluno'||n||'@performance.test','test-only-no-login','aluno' FROM generate_series(1,5000) n`);
  await client.query(
    `INSERT INTO aluno_profile(user_id,modalidade,faixa,contato_emergencia_nome,contato_emergencia_parentesco,contato_emergencia_telefone) SELECT id,'jiu_jitsu','branca','Contato','Mãe','5511900000000' FROM users`,
  );
  await client.query(`INSERT INTO attendance(user_id,check_in,check_out)
    SELECT id,now()-interval '1 hour',CASE WHEN row_number() OVER()<=5 THEN null ELSE now() END FROM users`);
  await client.query(
    `INSERT INTO financeiro(user_id,valor,data_vencimento) SELECT id,150,fn_hoje_sp()-10 FROM users`,
  );
  const id = (await client.query("SELECT id FROM users LIMIT 1")).rows[0].id;
  await client.query(
    `INSERT INTO cash_flow(tipo,valor,motivo,categoria,registrado_por,data)
    SELECT 'entrada',10,'Performance fixture','outros',$1,now()-make_interval(days=>n%365) FROM generate_series(1,10000) n`,
    [id],
  );
  await client.query("VACUUM (ANALYZE) users,aluno_profile,attendance,financeiro,cash_flow");
  const results = [];
  for (const [name, sql, values] of [
    ["presentes", "SELECT * FROM vw_presentes_agora ORDER BY check_in", []],
    ["pendencias", "SELECT * FROM fn_pendencias_bloqueantes($1,5)", [id]],
    ["busca", "SELECT id FROM users WHERE nome ILIKE '%4999%' OR email::text ILIKE '%4999%'", []],
    [
      "caixa",
      "SELECT sum(valor) FROM cash_flow WHERE data >= (fn_hoje_sp()::timestamp AT TIME ZONE 'America/Sao_Paulo') AND data < ((fn_hoje_sp()+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')",
      [],
    ],
  ]) {
    const plan = (await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`, values))
      .rows[0]["QUERY PLAN"][0];
    const indexes = [];
    function walk(node) {
      if (node["Index Name"]) indexes.push(node["Index Name"]);
      for (const child of node.Plans ?? []) walk(child);
    }
    walk(plan.Plan);
    results.push({
      query: name,
      planning_ms: plan["Planning Time"],
      execution_ms: plan["Execution Time"],
      indexes,
    });
  }
  await writeFile("docs/QUERY_AUDIT.json", JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} finally {
  await client.query("SET search_path=public");
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.end();
}
