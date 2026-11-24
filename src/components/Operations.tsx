import { useRef, useState } from "react";
import { ImageOff } from "lucide-react";
import type {
  Financeiro,
  InventoryProduct,
  LojaVenda,
  PedidoLoja,
  CashFlow,
  BalancoDiario,
  Paginated,
} from "../types/contract";
import { api, errorMessage } from "../lib/api";
import { prepararImagem } from "../lib/preparar-imagem";
import { StudentPicker } from "./Academy";
import { PainelMensalidades } from "./PainelMensalidades";
import {
  Card,
  Form,
  Loading,
  Table,
  Pager,
  Status,
  useResource,
  methods,
  brl,
  day,
  time,
  today,
  amount,
  labels,
  type Field,
} from "./ui";

/** Foto do produto no catálogo do aluno (mesmo preparo da foto de perfil). */
function ImagemProduto({ product, onChange }: { product: InventoryProduct; onChange: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function enviar(file?: File) {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const { blob } = await prepararImagem(file);
      await api(`/produtos/${product.product_id}/imagem`, { method: "PUT", raw: blob });
      onChange();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-4 py-2">
      {product.imagem_url ? (
        <img
          src={product.imagem_url}
          alt={product.nome}
          className="size-24 rounded-xl border border-border object-cover"
        />
      ) : (
        <span className="grid size-24 place-items-center rounded-xl border border-border bg-surface-raised text-text-muted">
          <ImageOff size={26} aria-hidden="true" />
        </span>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          {busy ? "Enviando…" : product.imagem_url ? "Trocar foto" : "Adicionar foto"}
        </button>
        {product.imagem_url && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={async () => {
              await api(`/produtos/${product.product_id}/imagem`, { method: "DELETE" });
              onChange();
            }}
          >
            Remover foto
          </button>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => void enviar(e.target.files?.[0])}
      />
      {error && <p className="error notice w-full">{error}</p>}
    </div>
  );
}

const PEDIDO_STATUS: Record<PedidoLoja["status"], string> = {
  solicitado: "Solicitado",
  atendido: "Atendido",
  cancelado: "Cancelado",
};
/** Intenções de compra vindas do catálogo do aluno (WhatsApp). */
function PedidosAlunos({ revision, onChange }: { revision: number; onChange: () => void }) {
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const r = useResource<
    Paginated<PedidoLoja & { aluno_nome: string; produto_nome: string; produto_estoque: number }>
  >(`/loja/pedidos?page=${page}`, revision);
  async function concluir(id: string, status: "atendido" | "cancelado") {
    setError("");
    try {
      await api(`/loja/pedidos/${id}`, { method: "PATCH", body: { status } });
      onChange();
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <Card title="Pedidos dos alunos">
      <p>
        Pedidos feitos pelo catálogo do aluno (a conversa segue no WhatsApp da loja). O pedido não
        baixa estoque: ao entregar, registre a venda em "Registrar venda" e marque como atendido.
      </p>
      {error && <p className="error notice">{error}</p>}
      <Loading {...r} />
      <Table
        headers={["Data", "Aluno", "Produto", "Qtd.", "Valor", "Status", "Ação"]}
        empty={r.data?.data.length === 0}
      >
        {r.data?.data.map((o) => (
          <tr key={o.id}>
            <td>{time(o.created_at)}</td>
            <td>{o.aluno_nome}</td>
            <td>
              {o.produto_nome}
              <small className="cell-note">Estoque atual: {o.produto_estoque}</small>
            </td>
            <td>{o.quantidade}</td>
            <td>{brl(o.preco_unitario)}</td>
            <td>{PEDIDO_STATUS[o.status]}</td>
            <td>
              {o.status === "solicitado" && (
                <div className="flex flex-wrap gap-2">
                  <button className="primary" onClick={() => void concluir(o.id, "atendido")}>
                    Atendido
                  </button>
                  <button className="secondary" onClick={() => void concluir(o.id, "cancelado")}>
                    Cancelar
                  </button>
                </div>
              )}
            </td>
          </tr>
        ))}
      </Table>
      <Pager page={page} total={r.data?.total ?? 0} onPage={setPage} />
    </Card>
  );
}

const moneyField: Field = {
  name: "valor",
  label: "Valor (R$)",
  type: "number",
  min: 0.01,
  step: "0.01",
};
export function Finance() {
  const [batchResult, setBatchResult] = useState("");
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [student, setStudent] = useState("");
  const [selected, setSelected] = useState<Financeiro>();
  const [revision, setRevision] = useState(0);
  // Baixas feitas no painel atualizam resumo e cobranças, mas não recarregam
  // o próprio painel (ele já mostrou o cartão verde pelo estado local).
  const [baixas, setBaixas] = useState(0);
  const r = useResource<Paginated<Financeiro & { nome: string }>>(
    `/mensalidades?page=${page}${status ? `&status=${status}` : ""}`,
    revision + baixas,
  );
  const current = today().slice(0, 7);
  const summary = useResource<{
    previsto: string;
    recebido: string;
    em_aberto: string;
    atrasado: string;
    taxa_inadimplencia: string;
  }>(`/financeiro/resumo?competencia=${current}`, revision + baixas);
  function reload() {
    setRevision((v) => v + 1);
    setSelected(undefined);
  }
  return (
    <>
      <Card title={`Financeiro · ${current}`}>
        <Loading {...summary} />
        {summary.data && (
          <div className="summary-grid">
            <p>
              Previsto<strong>{brl(summary.data.previsto)}</strong>
            </p>
            <p>
              Recebido<strong>{brl(summary.data.recebido)}</strong>
            </p>
            <p>
              Em aberto<strong>{brl(summary.data.em_aberto)}</strong>
            </p>
            <p>
              Atrasado<strong>{brl(summary.data.atrasado)}</strong>
            </p>
          </div>
        )}
      </Card>
      <PainelMensalidades
        tick={revision}
        podeDarBaixa
        onBaixa={() => {
          setBaixas((v) => v + 1);
          setSelected(undefined);
        }}
      />
      <Card
        title="Cobranças"
        action={
          <select
            aria-label="Filtrar status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Todos os status</option>
            <option value="pendente">Pendente</option>
            <option value="atrasado">Atrasado</option>
            <option value="pago">Pago</option>
          </select>
        }
      >
        <Loading {...r} />
        <Table
          headers={["Aluno", "Vencimento", "Valor", "Status", "Ação"]}
          empty={r.data?.data.length === 0}
        >
          {r.data?.data.map((f) => (
            <tr key={f.payment_id}>
              <td>{f.nome}</td>
              <td>{day(f.data_vencimento)}</td>
              <td>{brl(f.valor)}</td>
              <td>
                <Status value={f.status} />
              </td>
              <td>
                {f.status !== "pago" && (
                  <button className="secondary" onClick={() => setSelected(f)}>
                    Gerenciar
                  </button>
                )}
              </td>
            </tr>
          ))}
        </Table>
        <Pager page={page} total={r.data?.total ?? 0} onPage={setPage} />
      </Card>
      {selected && (
        <Card
          title={`Mensalidade de ${day(selected.data_vencimento)} · ${brl(selected.valor)}`}
          action={
            <button className="secondary" onClick={() => setSelected(undefined)}>
              Fechar
            </button>
          }
        >
          <Form
            key={`pay-${selected.payment_id}`}
            fields={[
              { name: "metodo_pagamento", label: "Método de pagamento", options: methods },
              { name: "data_pagamento", label: "Data do pagamento", type: "date", value: today() },
            ]}
            submit="Confirmar recebimento"
            onSubmit={async (b) => {
              await api(`/mensalidades/${selected.payment_id}/pagar`, { method: "PATCH", body: b });
              reload();
            }}
          />
          <details>
            <summary>Corrigir cobrança em aberto</summary>
            <Form
              key={selected.payment_id}
              fields={[
                { ...moneyField, value: selected.valor },
                {
                  name: "data_vencimento",
                  label: "Vencimento",
                  type: "date",
                  value: selected.data_vencimento,
                },
              ]}
              onSubmit={async (b) => {
                await api(`/mensalidades/${selected.payment_id}`, {
                  method: "PATCH",
                  body: { ...b, valor: amount(b.valor) },
                });
                reload();
              }}
            />
            <Form
              fields={[]}
              submit="Excluir cobrança lançada por engano"
              onSubmit={async () => {
                await api(`/mensalidades/${selected.payment_id}`, { method: "DELETE" });
                reload();
              }}
            />
          </details>
        </Card>
      )}
      <Card title="Nova mensalidade">
        <StudentPicker value={student} onChange={setStudent} />
        <Form
          fields={[
            moneyField,
            { name: "data_vencimento", label: "Vencimento", type: "date", value: today() },
          ]}
          submit="Criar mensalidade"
          onSubmit={async (b) => {
            if (!student) throw new Error("Selecione um aluno.");
            await api("/mensalidades", {
              method: "POST",
              body: { ...b, user_id: student, valor: amount(b.valor) },
            });
            reload();
          }}
        />
      </Card>
      <Card title="Gerar mensalidades em lote">
        <p>Cria cobranças para alunos ativos e inadimplentes, sem repetir o mesmo vencimento.</p>
        <Form
          fields={[
            { name: "competencia", label: "Competência", type: "month", value: current },
            {
              name: "dia_vencimento",
              label: "Dia do vencimento",
              type: "number",
              min: 1,
              max: 31,
              value: 10,
            },
            { ...moneyField, name: "valor_padrao" },
          ]}
          submit="Gerar lote"
          onSubmit={async (b) => {
            const result = await api<{ criadas: number; ignoradas: number }>("/mensalidades/lote", {
              method: "POST",
              body: {
                ...b,
                dia_vencimento: Number(b.dia_vencimento),
                valor_padrao: amount(b.valor_padrao),
              },
            });
            reload();
            setBatchResult(`${result.criadas} criadas; ${result.ignoradas} já existentes.`);
          }}
        />
        {batchResult && <p role="status">{batchResult}</p>}
      </Card>
    </>
  );
}
export function Store() {
  const [revision, setRevision] = useState(0);
  const [product, setProduct] = useState<InventoryProduct>();
  const [student, setStudent] = useState("");
  const [page, setPage] = useState(1);
  const [cart, setCart] = useState<{ product_id: string; quantidade: number; desconto: string }[]>(
    [],
  );
  const pending = useRef<{ signature: string; key: string } | null>(null);
  const r = useResource<InventoryProduct[]>("/produtos?incluir_inativos=true", revision);
  const sales = useResource<Paginated<LojaVenda & { aluno_nome: string; produto_nome: string }>>(
    `/vendas?page=${page}`,
    revision,
  );
  const [receipt, setReceipt] = useState("");
  const productFields: Field[] = [
    { name: "nome", label: "Nome do produto", value: product?.nome },
    {
      name: "preco",
      label: "Preço (R$)",
      type: "number",
      min: 0,
      step: "0.01",
      value: product?.preco,
    },
    { name: "categoria", label: "Categoria", value: product?.categoria },
    {
      name: "descricao",
      label: "Descrição no catálogo do aluno (opcional)",
      type: "textarea",
      value: product?.descricao ?? "",
      required: false,
    },
  ];
  return (
    <>
      <Card title="Produtos e estoque">
        <Loading {...r} />
        <Table
          headers={["Produto", "Preço", "Estoque", "Status", "Ação"]}
          empty={r.data?.length === 0}
        >
          {r.data?.map((p) => (
            <tr key={p.product_id}>
              <td>
                <span className="flex items-center gap-3">
                  {p.imagem_url ? (
                    <img
                      src={p.imagem_url}
                      alt=""
                      className="size-10 shrink-0 rounded-lg border border-border object-cover"
                    />
                  ) : (
                    <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-surface-raised text-text-muted">
                      <ImageOff size={16} aria-hidden="true" />
                    </span>
                  )}
                  {p.nome}
                </span>
              </td>
              <td>{brl(p.preco)}</td>
              <td>{p.estoque_atual}</td>
              <td>{p.ativo ? "Ativo" : "Inativo"}</td>
              <td>
                <button className="secondary" onClick={() => setProduct(p)}>
                  Editar
                </button>
              </td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card
        title={product ? `Editar ${product.nome}` : "Novo produto"}
        action={
          product && (
            <button className="secondary" onClick={() => setProduct(undefined)}>
              Novo produto
            </button>
          )
        }
      >
        <Form
          key={product?.product_id ?? "new"}
          fields={
            product
              ? [
                  ...productFields,
                  {
                    name: "ativo",
                    label: "Status",
                    value: String(product.ativo),
                    options: [
                      { value: "true", label: "Ativo" },
                      { value: "false", label: "Inativo" },
                    ],
                  },
                ]
              : [
                  ...productFields,
                  {
                    name: "estoque_atual",
                    label: "Estoque inicial",
                    type: "number",
                    min: 0,
                    value: 0,
                  },
                ]
          }
          onSubmit={async (b) => {
            await api(product ? `/produtos/${product.product_id}` : "/produtos", {
              method: product ? "PATCH" : "POST",
              body: product
                ? {
                    nome: b.nome,
                    preco: amount(b.preco),
                    categoria: b.categoria,
                    ativo: b.ativo === "true",
                    descricao: b.descricao?.trim() || null,
                  }
                : {
                    ...b,
                    preco: amount(b.preco),
                    estoque_atual: Number(b.estoque_atual),
                    descricao: b.descricao?.trim() || null,
                  },
            });
            setRevision((v) => v + 1);
            setProduct(undefined);
          }}
        />
        {product && (
          <>
            <h3>Foto no catálogo</h3>
            <ImagemProduto
              product={r.data?.find((p) => p.product_id === product.product_id) ?? product}
              onChange={() => setRevision((v) => v + 1)}
            />
            <h3>Movimentar estoque</h3>
            <Form
              key={`stock-${product.product_id}`}
              fields={[
                {
                  name: "operacao",
                  label: "Operação",
                  options: [
                    { value: "entrada", label: "Entrada" },
                    { value: "ajuste", label: "Ajuste (+ ou −)" },
                  ],
                },
                {
                  name: "quantidade",
                  label: "Quantidade a adicionar ou retirar",
                  type: "number",
                  min: -10000000,
                  max: 10000000,
                },
                { name: "motivo", label: "Motivo do movimento" },
              ]}
              onSubmit={async (b) => {
                await api(`/produtos/${product.product_id}/estoque`, {
                  method: "PATCH",
                  body: { ...b, quantidade: Number(b.quantidade) },
                });
                setRevision((v) => v + 1);
              }}
            />
          </>
        )}
      </Card>
      <PedidosAlunos revision={revision} onChange={() => setRevision((v) => v + 1)} />
      <Card title="Registrar venda">
        <StudentPicker value={student} onChange={setStudent} />
        <Form
          fields={[
            {
              name: "product_id",
              label: "Produto",
              options: [
                { value: "", label: "Selecione um produto" },
                ...(r.data ?? [])
                  .filter((p) => p.ativo)
                  .map((p) => ({ value: p.product_id, label: `${p.nome} · ${brl(p.preco)}` })),
              ],
            },
            {
              name: "quantidade",
              label: "Quantidade",
              type: "number",
              min: 1,
              max: 100000,
              value: 1,
            },
            {
              name: "desconto",
              label: "Desconto no item (R$)",
              type: "number",
              min: 0,
              step: "0.01",
              value: "0.00",
            },
          ]}
          submit="Adicionar ao carrinho"
          onSubmit={async (b) => {
            if (cart.some((i) => i.product_id === b.product_id))
              throw new Error("Remova o item existente antes de alterar sua quantidade.");
            setCart((v) => [
              ...v,
              {
                product_id: b.product_id,
                quantidade: Number(b.quantidade),
                desconto: amount(b.desconto),
              },
            ]);
          }}
        />
        <Table headers={["Produto", "Quantidade", "Desconto", "Ação"]} empty={!cart.length}>
          {cart.map((i) => (
            <tr key={i.product_id}>
              <td>{r.data?.find((p) => p.product_id === i.product_id)?.nome}</td>
              <td>{i.quantidade}</td>
              <td>{brl(i.desconto)}</td>
              <td>
                <button
                  className="secondary"
                  onClick={() => setCart((v) => v.filter((c) => c.product_id !== i.product_id))}
                >
                  Remover
                </button>
              </td>
            </tr>
          ))}
        </Table>
        <Form
          fields={[{ name: "metodo_pagamento", label: "Método de pagamento", options: methods }]}
          submit="Finalizar venda"
          onSubmit={async (b) => {
            if (!student || !cart.length)
              throw new Error("Selecione um aluno e adicione produtos.");
            const body = { user_id: student, itens: cart, metodo_pagamento: b.metodo_pagamento };
            const signature = JSON.stringify(body);
            if (pending.current?.signature !== signature)
              pending.current = { signature, key: crypto.randomUUID() };
            const sale = await api<{ total: string }>("/vendas", {
              method: "POST",
              body,
              key: pending.current.key,
            });
            setReceipt(`Venda registrada: ${brl(sale.total)}.`);
            setCart([]);
            pending.current = null;
            setRevision((v) => v + 1);
          }}
        />
        {receipt && <p role="status">{receipt}</p>}
      </Card>
      <Card title="Histórico de vendas">
        <Loading {...sales} />
        <Table
          headers={["Data", "Aluno", "Produto", "Quantidade", "Total"]}
          empty={sales.data?.data.length === 0}
        >
          {sales.data?.data.map((s) => (
            <tr key={s.sale_id}>
              <td>{time(s.data_venda)}</td>
              <td>{s.aluno_nome}</td>
              <td>{s.produto_nome}</td>
              <td>{s.quantidade}</td>
              <td>{brl(s.valor_total)}</td>
            </tr>
          ))}
        </Table>
        <Pager page={page} total={sales.data?.total ?? 0} onPage={setPage} />
      </Card>
    </>
  );
}
export function Cash() {
  const [date, setDate] = useState(today());
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const balance = useResource<BalancoDiario>(`/caixa/balanco?dia=${date}`, revision);
  const rows = useResource<Paginated<CashFlow>>(
    `/caixa/lancamentos?de=${date}&ate=${date}&page=${page}`,
    revision,
  );
  return (
    <>
      <Card
        title="Balanço diário"
        action={
          <input
            type="date"
            aria-label="Dia do balanço"
            required
            value={date}
            onChange={(e) => {
              if (e.target.value) setDate(e.target.value);
              setPage(1);
            }}
          />
        }
      >
        <Loading {...balance} />
        {balance.data && (
          <div className="summary-grid">
            <p>
              Entradas<strong>{brl(balance.data.total_entradas)}</strong>
            </p>
            <p>
              Saídas<strong>{brl(balance.data.total_saidas)}</strong>
            </p>
            <p>
              Saldo<strong>{brl(balance.data.saldo)}</strong>
            </p>
          </div>
        )}
        <Loading {...rows} />
        <Table
          headers={["Horário", "Tipo", "Categoria", "Motivo", "Valor"]}
          empty={rows.data?.data.length === 0}
        >
          {rows.data?.data.map((c) => (
            <tr key={c.transaction_id}>
              <td>{time(c.data)}</td>
              <td>{labels[c.tipo]}</td>
              <td>{c.categoria}</td>
              <td>{c.motivo}</td>
              <td>{brl(c.valor)}</td>
            </tr>
          ))}
        </Table>
        <Pager page={page} total={rows.data?.total ?? 0} onPage={setPage} />
      </Card>
      <Card title="Lançamento avulso">
        <p>
          Para corrigir um lançamento, registre o valor no sentido oposto e identifique o lançamento
          original no motivo.
        </p>
        <Form
          fields={[
            {
              name: "tipo",
              label: "Tipo",
              options: [
                { value: "entrada", label: "Entrada" },
                { value: "saida", label: "Saída" },
              ],
            },
            moneyField,
            { name: "motivo", label: "Motivo" },
          ]}
          onSubmit={async (b) => {
            await api("/caixa/lancamentos", {
              method: "POST",
              body: { ...b, valor: amount(b.valor) },
            });
            setRevision((v) => v + 1);
          }}
        />
      </Card>
      <Card title="Sangria">
        <Form
          fields={[moneyField, { name: "motivo", label: "Motivo da retirada" }]}
          submit="Registrar sangria"
          onSubmit={async (b) => {
            await api("/caixa/sangrias", {
              method: "POST",
              body: { ...b, valor: amount(b.valor) },
            });
            setRevision((v) => v + 1);
          }}
        />
      </Card>
    </>
  );
}
