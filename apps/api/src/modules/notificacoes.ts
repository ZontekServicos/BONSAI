/**
 * Notificações de cobrança via WhatsApp (link wa.me pré-preenchido).
 *
 *   POST /notificacoes/cobrar  { payment_id }   admin
 *
 * Não envia nada sozinho: devolve a mensagem e o link wa.me; quem dispara é o
 * gestor, no WhatsApp dele. Por isso não grava nada no banco.
 *
 * Destinatário:
 *   menor de 18 anos (data de nascimento, fuso de São Paulo) → SEMPRE o
 *     responsável, mesmo que o aluno tenha WhatsApp próprio;
 *   maior de idade → o próprio aluno; se ele não tiver WhatsApp e houver
 *     responsável cadastrado, o responsável;
 *   sem nenhum número → 422 SEM_WHATSAPP.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { one } from "../db.js";
import { route, uuid, fail, found, type Context } from "../http.js";

const MESES = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

/** "2026-11" → "novembro de 2026". */
export const competenciaPorExtenso = (competencia: string) => {
  const [ano, mes] = competencia.split("-").map(Number);
  return `${MESES[mes - 1]} de ${ano}`;
};

/** "1234.50" → "1.234,50" (sem depender do ICU do servidor). */
export const valorBR = (valor: string) => {
  const [inteiro, centavos = "00"] = valor.split(".");
  return `${inteiro.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${centavos.padEnd(2, "0")}`;
};

const primeiroNome = (nome: string) => nome.trim().split(/\s+/)[0];

export const mensagemCobranca = (m: {
  destinatario: string;
  aluno: string;
  competencia: string;
  valor: string;
  pix: string;
}) =>
  `Olá, ${primeiroNome(m.destinatario)}! Notamos que a mensalidade de ${m.aluno} ` +
  `referente a ${competenciaPorExtenso(m.competencia)} ainda está pendente. ` +
  `Valor: R$ ${valorBR(m.valor)}. Segue a chave Pix: ${m.pix}`;

export function notificacoesRoutes(app: FastifyInstance, ctx: Context) {
  const { db, config } = ctx;

  route(
    app,
    ctx,
    "POST",
    "/notificacoes/cobrar",
    { role: "admin", body: z.strictObject({ payment_id: uuid }) },
    async (_r, _s, b) => {
      const pix = config.PIX_CHAVE;
      if (!pix)
        fail(
          503,
          "PIX_NAO_CONFIGURADO",
          "A chave Pix da academia ainda não foi configurada (PIX_CHAVE).",
        );
      const c = found(
        await one(
          db,
          `SELECT f.payment_id, f.user_id, f.status, f.valor,
                  to_char(f.data_vencimento, 'YYYY-MM') AS competencia,
                  EXISTS (SELECT 1 FROM cash_flow cf WHERE cf.payment_id = f.payment_id) AS no_caixa,
                  u.nome AS aluno_nome, p.whatsapp AS aluno_whatsapp,
                  coalesce(p.data_nascimento > (fn_hoje_sp() - interval '18 years')::date, false) AS menor,
                  r.nome AS responsavel_nome, r.whatsapp AS responsavel_whatsapp
             FROM financeiro f
             JOIN users u ON u.id = f.user_id
             JOIN aluno_profile p ON p.user_id = f.user_id
             LEFT JOIN responsaveis r ON r.id = p.responsavel_id
            WHERE f.payment_id = $1`,
          [b.payment_id],
        ),
      );
      if (c.status === "pago" || c.no_caixa)
        fail(409, "MENSALIDADE_JA_PAGA", "Esta mensalidade já está paga.");

      const responsavel = c.responsavel_whatsapp
        ? {
            tipo: "responsavel" as const,
            nome: c.responsavel_nome as string,
            whatsapp: c.responsavel_whatsapp as string,
          }
        : null;
      const aluno = c.aluno_whatsapp
        ? {
            tipo: "aluno" as const,
            nome: c.aluno_nome as string,
            whatsapp: c.aluno_whatsapp as string,
          }
        : null;
      const destinatario = c.menor ? responsavel : (aluno ?? responsavel);
      if (!destinatario)
        fail(
          422,
          "SEM_WHATSAPP",
          c.menor
            ? `${c.aluno_nome} é menor de idade e não tem responsável com WhatsApp cadastrado.`
            : `${c.aluno_nome} não tem WhatsApp cadastrado.`,
        );

      const mensagem = mensagemCobranca({
        destinatario: destinatario.nome,
        aluno: c.aluno_nome,
        competencia: c.competencia,
        valor: c.valor,
        pix,
      });
      return {
        payment_id: c.payment_id,
        user_id: c.user_id,
        aluno_nome: c.aluno_nome,
        menor_de_idade: c.menor,
        competencia: c.competencia,
        valor: c.valor,
        destinatario,
        mensagem,
        whatsapp_url: `https://wa.me/${destinatario.whatsapp}?text=${encodeURIComponent(mensagem)}`,
      };
    },
  );
}
