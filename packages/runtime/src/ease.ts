export const ease: Record<string, (t: number) => number> = {
  lin: t => t,
  out: t => 1 - Math.pow(1 - t, 3),
  inOut: t => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  back: t => { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
  sine: t => -(Math.cos(Math.PI * t) - 1) / 2,
};
export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
