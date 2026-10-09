/**
 * 面の色。簡易ランバートで明度だけを変える。
 *
 * 光源はカメラに追従させない。追従させると回転しても明暗が変わらず、立体感が出ない。
 */

/** 影側でも真っ黒にならない下限 */
const AMBIENT = 0.35;

/** 左手前の上から。z が上の右手系 */
const LIGHT = { x: -0.37, y: -0.55, z: 0.75 };

export function lambert(normal: { x: number; y: number; z: number }): number {
  const d = normal.x * LIGHT.x + normal.y * LIGHT.y + normal.z * LIGHT.z;
  return AMBIENT + (1 - AMBIENT) * Math.max(0, d);
}

/** `#rrggbb` と `rgba(r, g, b, a)` に対応する。それ以外はそのまま返す */
export function shade(color: string, k: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));

  if (color.startsWith('#') && color.length === 7) {
    const r = clamp(parseInt(color.slice(1, 3), 16));
    const g = clamp(parseInt(color.slice(3, 5), 16));
    const b = clamp(parseInt(color.slice(5, 7), 16));
    return `rgb(${r}, ${g}, ${b})`;
  }

  const rgba = color.match(/^rgba?\(([^)]+)\)$/);
  if (rgba) {
    const parts = rgba[1].split(',').map((s) => Number(s.trim()));
    if (parts.length >= 3 && parts.every((n) => Number.isFinite(n))) {
      const [r, g, b, a = 1] = parts;
      return `rgba(${clamp(r)}, ${clamp(g)}, ${clamp(b)}, ${a})`;
    }
  }
  return color;
}
