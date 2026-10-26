import { pointInPolygon } from '../core/geometry.ts';
import { LAYER_IDS, resolveNewLayer } from '../core/layer.ts';
import { roomAt } from '../core/rooms.ts';
import { newId } from '../core/types.ts';
import type { Frame } from '../render/renderer.ts';
import { fontOf, theme } from '../render/theme.ts';
import type { Editor } from '../ui/editor.ts';
import type { OptionField, PointerInfo, Tool } from './tool.ts';

/** オプションバーに並べる部屋名の候補 */
export const ROOM_NAME_SUGGESTIONS = [
  'LDK', '洋室', '和室', '寝室', '浴室', '洗面', 'トイレ', '玄関', '廊下', 'クローゼット',
] as const;

/** 検出済みの部屋に名前を付けるツール。部屋そのものは壁から自動で決まる */
export class RoomTool implements Tool {
  readonly id = 'room' as const;
  readonly label = '部屋名';
  readonly shortcut = 'N';
  readonly cursor = 'text';
  readonly group = 'annotate' as const;

  /** ツールバーの入力欄と同期する部屋名 */
  name = 'リビング';

  onActivate(editor: Editor): void {
    editor.store.clearSelection();
  }

  onPointerDown(editor: Editor, p: PointerInfo): void {
    if (p.button !== 0) return;
    const room = roomAt(editor.rooms, p.raw);
    if (!room) return;
    const store = editor.store;
    const label = this.name.trim();

    store.commit(() => {
      // すでにその部屋にラベルがあれば置き換える
      const existing = Object.values(store.scene.roomLabels).find((l) =>
        pointInPolygon({ x: l.x, y: l.y }, room.polygon),
      );
      if (!label) {
        if (!existing) return false;
        delete store.scene.roomLabels[existing.id];
        return true;
      }
      if (existing) {
        existing.name = label;
        existing.x = room.center.x;
        existing.y = room.center.y;
        return true;
      }
      const id = newId('l');
      const layerId = resolveNewLayer(store.scene.layers, store.settings.currentLayerId, LAYER_IDS.roomName);
      store.scene.roomLabels[id] = { id, x: room.center.x, y: room.center.y, name: label, layerId, levelId: store.scene.activeLevelId };
      return true;
    });
  }

  drawOverlay(editor: Editor, frame: Frame): void {
    const room = roomAt(editor.rooms, editor.pointerWorld());
    if (!room) return;
    const { ctx, vp } = frame;
    ctx.save();
    ctx.beginPath();
    const poly = room.innerPolygon.length >= 3 ? room.innerPolygon : room.polygon;
    poly.forEach((q, i) => {
      const s = vp.toScreen(q);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(37, 99, 235, 0.12)';
    ctx.fill();
    ctx.strokeStyle = theme.preview;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const c = vp.toScreen(room.center);
    ctx.font = fontOf(14, 600);
    ctx.fillStyle = theme.preview;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.name || '(名前を消す)', c.x, c.y - 9);
    ctx.restore();
  }

  options(): OptionField[] {
    return [
      {
        kind: 'text',
        label: '部屋名',
        value: this.name,
        placeholder: '部屋名',
        onChange: (v) => void (this.name = v),
      },
      { kind: 'chips', items: [...ROOM_NAME_SUGGESTIONS], onPick: (s) => void (this.name = s) },
    ];
  }

  status(editor: Editor): string {
    if (editor.rooms.length === 0) return '壁で閉じた領域を作ると部屋として認識されます';
    return `部屋をクリックして「${this.name || '(空欄 = 名前を消す)'}」を割り当て`;
  }
}
