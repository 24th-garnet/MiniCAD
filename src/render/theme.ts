export const theme = {
  paper: '#f7f6f3',
  gridMinor: '#e3e0d8',
  gridMajor: '#d2cec2',
  axis: '#c0b9a6',
  wall: '#3f3f46',
  wallSelected: '#1d4ed8',
  wallHover: '#6b7280',
  node: '#ffffff',
  nodeStroke: '#3f3f46',
  nodeSelected: '#1d4ed8',
  roomFill: '#ffffff',
  roomFillAlt: 'rgba(37, 99, 235, 0.05)',
  roomName: '#27272a',
  roomArea: '#71717a',
  dimension: '#9a8c6a',
  dimensionText: '#6b6047',
  furniture: 'rgba(120, 113, 108, 0.14)',
  furnitureStroke: '#78716c',
  furnitureSelected: '#1d4ed8',
  furnitureText: '#57534e',
  opening: '#3f3f46',
  door: '#52525b',
  window: '#2563eb',
  snap: '#f97316',
  preview: '#2563eb',
  selectionRect: 'rgba(37, 99, 235, 0.12)',
  selectionRectStroke: '#2563eb',
  crossingRect: 'rgba(22, 163, 74, 0.12)',
  crossingRectStroke: '#16a34a',
  constraint: '#7c3aed',
  constraintConflict: '#dc2626',
} as const;

export const FONT_FAMILY = 'system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';

/** 文字の大きさは製図規格から来るので、サイズを受け取って font 文字列を組み立てる */
export const fontOf = (sizePx: number, weight = 400): string =>
  `${weight} ${sizePx.toFixed(2)}px ${FONT_FAMILY}`;
