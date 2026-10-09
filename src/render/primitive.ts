import type { Layer } from '../core/layer.ts';
import type { Primitive } from '../core/primitive.ts';
import { LINE_TYPE_PATTERNS } from '../core/standard.ts';
import { fontOf, theme } from './theme.ts';
import { applyLayer, normalizeTextAngle, strokeSegments, textPx, tracePolygon, type Frame } from './frame.ts';

/** 中間表現を Canvas に描く3つのバックエンドのうちの1つ */
export function drawPrimitives(frame: Frame, prims: Primitive[], layer: Layer, accent?: string | null): void {
  const { ctx, vp } = frame;
  const color = accent ?? layer.color;

  for (const prim of prims) {
    applyLayer(frame, layer, accent);
    // 記号が自前の線種を持っていれば画層の線種より優先する（dashPx と同じ式）
    if ('lineType' in prim && prim.lineType) {
      const pattern = LINE_TYPE_PATTERNS[prim.lineType].map((mm) => mm * frame.scene.standard.scale);
      ctx.setLineDash(pattern.map((mm) => Math.max(1, vp.toScreenLength(mm))));
    }

    switch (prim.kind) {
      case 'segments':
        strokeSegments(frame, prim.segments);
        break;

      case 'arc': {
        const c = vp.toScreen(prim.center);
        const r = vp.toScreenLength(prim.radius);
        // 画面は y 下向きなので角度の符号を反転し、掃く向きも入れ替える
        ctx.beginPath();
        ctx.arc(c.x, c.y, r, -prim.startAngle, -prim.endAngle, true);
        ctx.stroke();
        break;
      }

      case 'circle': {
        const c = vp.toScreen(prim.center);
        const r = vp.toScreenLength(prim.radius);
        ctx.beginPath();
        ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }

      case 'polygon': {
        tracePolygon(frame, prim.points);
        if (prim.fill !== 'none') {
          ctx.fillStyle = prim.fill === 'paper' ? theme.paper : color;
          ctx.fill();
        }
        ctx.stroke();
        break;
      }

      case 'text': {
        const size = textPx(prim.paperMm);
        const at = vp.toScreen(prim.at);
        ctx.save();
        ctx.setLineDash([]);
        ctx.translate(at.x, at.y);
        ctx.rotate(-normalizeTextAngle(prim.angle));
        ctx.font = fontOf(size);
        ctx.fillStyle = prim.color ?? color;
        ctx.textAlign = prim.align === 'center' ? 'center' : prim.align === 'right' ? 'right' : 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(prim.text, 0, 0);
        ctx.restore();
        break;
      }
    }
  }
  ctx.setLineDash([]);
}
