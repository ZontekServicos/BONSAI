/**
 * Contas de demonstração para testar o controle de acesso (RBAC).
 *
 *   pnpm demo:seed
 *
 * Cria (ou redefine) usuários reais no banco, com senha em Argon2id:
 *   - Gestor    (admin)     — tudo, inclusive financeiro
 *   - Professor (professor) — alunos, graduações e presença; sem financeiro
 *   - Aluno     (aluno)     — ficha completa e mensalidade do mês paga
 *   - Aluno menor (sem login de demo) — vinculado a um responsável
 *
 * Idempotente. Recusa NODE_ENV=production e fica fora do build da API.
 * CPFs abaixo são números de TESTE válidos pelo algoritmo, sem titular real.
 */
import pg from "pg";
import { hashPassword } from "./auth.js";
import { DEMO_ACCOUNTS } from "../../../src/lib/demo-accounts.js";
import { TERMOS_VERSAO_ATUAL } from "../../../src/lib/cadastro.js";

if (process.env.NODE_ENV === "production") {
  throw new Error("demo:seed não pode rodar com NODE_ENV=production.");
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

// Contas demo usam o domínio reservado bonsai.demo: o papel pode ser corrigido
// (ex.: o antigo "professor" admin vira professor de fato).
const upsertUser = `
  INSERT INTO users(nome, email, password_hash, role, status)
  VALUES ($1, $2, $3, $4, 'ativo')
  ON CONFLICT (email) DO UPDATE
     SET nome = EXCLUDED.nome, password_hash = EXCLUDED.password_hash,
         role = EXCLUDED.role, status = 'ativo'
  RETURNING id`;
const ensure = async (nome: string, email: string, password: string, role: string) =>
  (await client.query(upsertUser, [nome, email, await hashPassword(password), role])).rows[0]
    .id as string;

try {
  await client.query("BEGIN");
  const { gestor, professor, aluno } = DEMO_ACCOUNTS;
  const gestorId = await ensure(gestor.nome, gestor.email, gestor.password, gestor.role);
  const professorId = await ensure(
    professor.nome,
    professor.email,
    professor.password,
    professor.role,
  );
  const alunoId = await ensure(aluno.nome, aluno.email, aluno.password, aluno.role);
  const menorId = await ensure("Aluno Menor Demo", "menor@bonsai.demo", aluno.password, "aluno");

  // Senha redefinida ⇒ sessões antigas dessas contas deixam de valer.
  await client.query(
    "UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = ANY($1) AND revoked_at IS NULL",
    [[gestorId, professorId, alunoId, menorId]],
  );

  const responsavelId: string = (
    await client.query(
      `INSERT INTO responsaveis(id, nome, parentesco, whatsapp, telefone_emergencia, email)
       VALUES ('00000000-0000-4000-8000-00000000d3e0', 'Responsável Demo', 'mae',
               '5511900000001', '5511900000002', 'responsavel@bonsai.demo')
       ON CONFLICT (id) DO UPDATE SET nome = EXCLUDED.nome
       RETURNING id`,
    )
  ).rows[0].id;

  const profile = `
    INSERT INTO aluno_profile(user_id, modalidade, faixa, graduacao_nivel, genero, rg, cpf,
      data_nascimento, endereco, bairro, cidade, cep, whatsapp, professor_responsavel,
      responsavel_id, termos_aceitos, termos_aceitos_em, termos_versao,
      contato_emergencia_nome, contato_emergencia_parentesco, contato_emergencia_telefone,
      autoriza_uso_imagem, autoriza_grupo_whatsapp, nivel)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Rua do Dojo, 100', 'Centro', 'São Paulo', '01001000',
      $9, $10, $11, true, now(), $12, $13, $14, $15, true, $16, $17)
    ON CONFLICT (user_id) DO UPDATE SET
      genero = EXCLUDED.genero, rg = EXCLUDED.rg, cpf = EXCLUDED.cpf,
      data_nascimento = EXCLUDED.data_nascimento, endereco = EXCLUDED.endereco,
      bairro = EXCLUDED.bairro, cidade = EXCLUDED.cidade, cep = EXCLUDED.cep,
      whatsapp = EXCLUDED.whatsapp, professor_responsavel = EXCLUDED.professor_responsavel,
      responsavel_id = EXCLUDED.responsavel_id, termos_aceitos = true,
      termos_aceitos_em = coalesce(aluno_profile.termos_aceitos_em, now()),
      termos_versao = EXCLUDED.termos_versao,
      contato_emergencia_nome = EXCLUDED.contato_emergencia_nome,
      contato_emergencia_parentesco = EXCLUDED.contato_emergencia_parentesco,
      contato_emergencia_telefone = EXCLUDED.contato_emergencia_telefone,
      autoriza_uso_imagem = EXCLUDED.autoriza_uso_imagem,
      autoriza_grupo_whatsapp = EXCLUDED.autoriza_grupo_whatsapp,
      nivel = EXCLUDED.nivel`;
  // Adulto, com WhatsApp próprio.
  await client.query(profile, [
    alunoId,
    "jiu_jitsu",
    "azul",
    2,
    "masculino",
    "12.345.678-9",
    "52998224725",
    "1995-05-20",
    "5511999990000",
    professor.nome,
    null,
    TERMOS_VERSAO_ATUAL,
    "Contato Emergência Demo",
    "Cônjuge",
    "5511900000003",
    true,
    null, // Jiu-Jitsu: faixa + grau
  ]);
  // Menor: sem WhatsApp próprio ⇒ o do responsável é o canal principal.
  await client.query(profile, [
    menorId,
    "muay_thai",
    "branca",
    0,
    "feminino",
    "98.765.432-1",
    "11144477735",
    `${new Date().getFullYear() - 12}-03-15`,
    null,
    professor.nome,
    responsavelId,
    TERMOS_VERSAO_ATUAL,
    "Responsável Demo",
    "Mãe",
    "5511900000002",
    false,
    "iniciante", // Muay Thai: nível (faixa vira "Iniciante")
  ]);
  const saude = `
    INSERT INTO historico_saude(user_id, tipo_sanguineo, condicoes_medicas, lesoes_cronicas,
      medicacao_continua, artes_marciais_anteriores, atualizado_por)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (user_id) DO NOTHING`;
  await client.query(saude, [
    alunoId,
    "O+",
    null,
    "Joelho direito (menisco, 2021)",
    null,
    "Judô por 3 anos",
    professorId,
  ]);
  await client.query(saude, [
    menorId,
    "A+",
    "Asma leve",
    null,
    "Bombinha se necessário",
    null,
    professorId,
  ]);

  // Mensalidades do mês corrente pagas (+ caixa), para as carteirinhas liberarem.
  for (const id of [alunoId, menorId]) {
    const paid = await client.query(
      `INSERT INTO financeiro(user_id, valor, data_vencimento, data_pagamento, status, metodo_pagamento)
       VALUES ($1, 150.00, date_trunc('month', fn_hoje_sp())::date + 9, fn_hoje_sp(), 'pago', 'pix')
       ON CONFLICT (user_id, data_vencimento) DO NOTHING
       RETURNING payment_id, valor`,
      [id],
    );
    if (paid.rows[0])
      await client.query(
        `INSERT INTO cash_flow(tipo, valor, motivo, categoria, payment_id, registrado_por)
         VALUES ('entrada', $1, 'Mensalidade (demonstração)', 'mensalidade', $2, $3)`,
        [paid.rows[0].valor, paid.rows[0].payment_id, gestorId],
      );
    await client.query("SELECT fn_sincronizar_status_aluno($1, 5)", [id]);
  }

  await client.query("COMMIT");
  console.info("Contas de demonstração prontas:");
  for (const a of Object.values(DEMO_ACCOUNTS))
    console.info(`  ${a.role.padEnd(9)} ${a.email.padEnd(24)} ${a.password}`);
  console.info(`  aluno     menor@bonsai.demo        ${aluno.password}  (menor, com responsável)`);
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  await client.end();
}
