/**
 * 呼ばれたメソッドを記録するだけの CanvasRenderingContext2D 代替。
 *
 * **有限でない数値を渡すと throw する。** 3D では w 除算やゼロベクトルの正規化で
 * ∞ / NaN が出やすいので、near クリップの漏れやカメラの縮退がここで自動的に落ちる。
 *
 * ファイル名に `.test.ts` を付けないこと（`node --test tests/` が実行対象として拾う）。
 */
export function stubContext() {
  const calls: string[] = [];
  const noop =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push(name);
      for (const a of args) {
        if (typeof a === 'number' && !Number.isFinite(a)) {
          throw new Error(`${name} に有限でない数値が渡されました: ${String(a)}`);
        }
      }
    };
  const ctx: Record<string, unknown> = {
    save: noop('save'),
    restore: noop('restore'),
    beginPath: noop('beginPath'),
    closePath: noop('closePath'),
    moveTo: noop('moveTo'),
    lineTo: noop('lineTo'),
    rect: noop('rect'),
    arc: noop('arc'),
    ellipse: noop('ellipse'),
    fill: noop('fill'),
    stroke: noop('stroke'),
    fillRect: noop('fillRect'),
    strokeRect: noop('strokeRect'),
    fillText: noop('fillText'),
    translate: noop('translate'),
    rotate: noop('rotate'),
    setLineDash: noop('setLineDash'),
    measureText: (t: string) => ({ width: t.length * 6 }),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}
