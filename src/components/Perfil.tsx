/**
 * Peças leves do perfil (sem Zod): avatar, formatação de medidas e o botão
 * de lápis. O modal de edição fica em EditarPerfil.tsx, carregado só ao abrir.
 */
import { useEffect, useState } from "react";
import { Pencil } from "lucide-react";

const numero = (v: number, casas: number) =>
  new Intl.NumberFormat("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: 2 }).format(v);
export const alturaTexto = (v: number | null) => (v == null ? "—" : `${numero(v, 2)} m`);
export const pesoTexto = (v: number | null) => (v == null ? "—" : `${numero(v, 1)} kg`);

export function Avatar({
  nome,
  foto,
  className = "",
}: {
  nome: string;
  foto: string | null;
  className?: string;
}) {
  const [falhou, setFalhou] = useState(false);
  useEffect(() => setFalhou(false), [foto]);
  return foto && !falhou ? (
    <img
      src={foto}
      alt={`Foto de ${nome}`}
      onError={() => setFalhou(true)}
      className={`aspect-square object-cover ${className}`}
    />
  ) : (
    <span aria-hidden="true" className={`grid aspect-square place-items-center ${className}`}>
      {nome.trim()[0]?.toUpperCase()}
    </span>
  );
}


export function BotaoEditarPerfil({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Editar perfil"
      className="grid size-10 shrink-0 place-items-center rounded-full border border-border-strong text-text-muted transition hover:border-primary hover:text-text-main"
    >
      <Pencil size={17} />
    </button>
  );
}
