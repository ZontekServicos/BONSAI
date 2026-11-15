import { useEffect, useState } from "react";

/**
 * Logo BONSAI — Jiu Jitsu Fight.
 *
 * O emblema é raster (public/assets) e troca de arte conforme o espaço disponível;
 * o wordmark é texto HTML, então fica nítido em qualquer densidade de tela e é lido
 * por leitores de tela.
 *
 *   ≥ 1024px  → logo-full.png   (emblema completo, com anel externo)
 *   ≥ 360px   → logo-mobile.png (sem anel externo, mais contraste)
 *   < 360px   → logo-icon.png   (só sol + bonsai) e o wordmark some
 *   collapsed → logo-icon.png   (header compacto ao rolar)
 */
export const LOGO_SRC = {
  full: "/assets/logo-full.png",
  mobile: "/assets/logo-mobile.png",
  icon: "/assets/logo-icon.png",
} as const;

type Variant = "responsive" | "full" | "compact" | "icon";

const EMBLEM_SIZE: Record<Variant, string> = {
  responsive: "size-12 sm:size-14 lg:size-24",
  full: "size-28 sm:size-36",
  compact: "size-11",
  icon: "size-10",
};

const WORDMARK_SIZE: Record<Variant, string> = {
  responsive: "text-[13px] sm:text-[15px] lg:text-[22px]",
  full: "text-[20px] sm:text-[26px]",
  compact: "text-[13px]",
  icon: "",
};

export function Logo({
  variant = "responsive",
  collapsed = false,
  stacked = false,
  priority = false,
  className = "",
}: {
  variant?: Variant;
  /** Força o símbolo e esconde o wordmark (header compacto). */
  collapsed?: boolean;
  /** Emblema acima do wordmark (splash / hero). */
  stacked?: boolean;
  /** Logo acima da dobra: carrega com prioridade. */
  priority?: boolean;
  className?: string;
}) {
  const iconOnly = variant === "icon" || collapsed;
  const src = variant === "full" ? LOGO_SRC.full : variant === "compact" ? LOGO_SRC.mobile : LOGO_SRC.icon;

  return (
    <span
      className={`inline-flex items-center ${stacked ? "flex-col gap-4 text-center" : "gap-3"} ${className}`}
    >
      <span className="sr-only">Bonsai Jiu Jitsu Fight</span>
      <picture className="block shrink-0" aria-hidden="true">
        {variant === "responsive" && !collapsed && [
          <source key="lg" media="(min-width: 1024px)" srcSet={LOGO_SRC.full} />,
          <source key="sm" media="(min-width: 360px)" srcSet={LOGO_SRC.mobile} />,
        ]}
        <img
          key="img"
          src={collapsed ? LOGO_SRC.icon : src}
          alt=""
          width={512}
          height={512}
          decoding="async"
          fetchPriority={priority ? "high" : "auto"}
          draggable={false}
          className={`${collapsed ? "size-10" : EMBLEM_SIZE[variant]} rounded-full object-contain ring-1 ring-bonsai-paper/25 drop-shadow-[0_6px_18px_rgb(178_34_34/0.35)] transition-[width,height] duration-300`}
        />
      </picture>
      {variant !== "icon" && (
        <Wordmark
          hidden={iconOnly}
          stacked={stacked}
          className={`${WORDMARK_SIZE[variant]} ${variant === "responsive" ? "max-[359px]:hidden" : ""}`}
        />
      )}
    </span>
  );
}

/** Tipografia "BONSAI / JIU JITSU / FIGHT". Escala por font-size (em). */
export function Wordmark({
  hidden = false,
  stacked = false,
  className = "",
}: {
  hidden?: boolean;
  stacked?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`flex select-none flex-col overflow-hidden leading-none transition-all duration-300 ${
        stacked ? "items-center" : "items-start"
      } ${hidden ? "max-w-0 opacity-0" : "max-w-[14em] opacity-100"} ${className}`}
    >
      <span className="font-display text-[2em] font-black italic tracking-[-0.02em] text-white uppercase [text-shadow:2px_2px_0_var(--color-bonsai-red-deep)]">
        Bonsai
      </span>
      <span className="mt-[0.15em] flex items-center gap-[0.4em] text-[max(0.55em,8px)] font-bold tracking-[0.32em] text-bonsai-ember uppercase">
        <i className="h-px w-[1.2em] bg-current" />
        Jiu Jitsu
        <i className="h-px w-[1.2em] bg-current" />
      </span>
      <span
        className={`font-display text-[1.05em] font-extrabold italic tracking-wide text-bonsai-paper uppercase ${
          stacked ? "" : "self-end"
        } -rotate-3`}
      >
        Fight
      </span>
    </span>
  );
}

/** true quando a janela rolou além de `threshold` px. */
export function useScrolled(threshold = 24) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > threshold);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [threshold]);
  return scrolled;
}
