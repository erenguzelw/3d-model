// Sayfa kaydırmasını durak ilerlemesine (0 … N-1) çevirir; yumuşatılmış değer döner.
export function createScrollProgress(stopCount) {
  const n = stopCount - 1;
  const max = () => Math.max(1, document.documentElement.scrollHeight - innerHeight);
  const raw = () => (scrollY / max()) * n;
  let value = raw();

  return {
    get value() { return value; },
    /** her karede çağrılır; dt saniye */
    update(dt) {
      const target = raw();
      value += (target - value) * (1 - Math.exp(-dt * 6));
      if (Math.abs(target - value) < 1e-4) value = target;
      return value;
    },
    scrollToStop(i, behavior = 'smooth') {
      scrollTo({ top: (i / n) * max(), behavior });
    },
    nearestStop: () => Math.round(raw()),
    target: raw,
  };
}
