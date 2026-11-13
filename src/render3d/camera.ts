import type { Bounds, Vec } from '../core/geometry.ts';
import {
  cross3,
  mat4LookAt,
  mat4Multiply,
  mat4Ortho,
  mat4Perspective,
  normalize3,
  scale3,
  sub3,
  transformPoint,
  vec3,
  type Mat4,
  type Vec3,
} from './mat4.ts';

/**
 * 注視点のまわりを回る軌道カメラ。
 *
 * 投影の種類は型に最初から持たせてある。透視と平行で違うのは投影行列 1 個だけで、
 * クリップ・カリング・ソート・塗りはすべて共通の経路を通る。
 */
export interface Camera3D {
  target: Vec3;
  distance: number;
  /** z 軸まわりの回転 */
  yaw: number;
  /** 水平からの仰角 */
  pitch: number;
  fovY: number;
  mode: 'perspective' | 'ortho';
}

/** 真上・真下では up と視線が平行になり lookAt が NaN になるので、少し手前で止める */
const PITCH_LIMIT = Math.PI / 2 - 0.01;
const MIN_DISTANCE = 100;
const MAX_DISTANCE = 5_000_000;
/** mm。部屋の中にカメラが入っても面が潰れない程度に小さく取る */
const NEAR = 50;
const FAR = 10_000_000;

/** z が上の右手系。既定は南東の上空から見下ろす */
const UP = vec3(0, 0, 1);

export const defaultCamera = (): Camera3D => ({
  target: vec3(0, 0, 1200),
  distance: 18000,
  yaw: -Math.PI / 2.4,
  pitch: 0.55,
  fovY: Math.PI / 4,
  mode: 'perspective',
});

export const clampPitch = (p: number): number => Math.min(PITCH_LIMIT, Math.max(-PITCH_LIMIT, p));

/**
 * 画面の縦横比。幅も高さも 0 のときは 1 に落とす。
 *
 * **`viewProjection` と `screenRay` が同じ式を使う**ための切り出し。
 * 別々に書くと、片方だけ直したときに拾う位置が静かにずれる。
 */
export const aspectOf = (width: number, height: number): number =>
  width > 0 && height > 0 ? width / height : 1;

/** カメラの正規直交基底。`pan` も `cameraRight` も `screenRay` もこれを使う */
export interface CameraBasis {
  eye: Vec3;
  forward: Vec3;
  right: Vec3;
  up: Vec3;
}

export function cameraBasis(cam: Camera3D): CameraBasis {
  const eye = cameraEye(cam);
  const forward = normalize3(sub3(cam.target, eye));
  const right = normalize3(cross3(forward, UP), vec3(1, 0, 0));
  return { eye, forward, right, up: cross3(right, forward) };
}

export function cameraEye(cam: Camera3D): Vec3 {
  const cp = Math.cos(cam.pitch);
  return vec3(
    cam.target.x + cam.distance * cp * Math.cos(cam.yaw),
    cam.target.y + cam.distance * cp * Math.sin(cam.yaw),
    cam.target.z + cam.distance * Math.sin(cam.pitch),
  );
}

export interface View {
  /** ワールド → クリップ空間 */
  matrix: Mat4;
  /** ワールド → カメラ空間。near クリップと深度ソートに使う */
  view: Mat4;
  /** カメラ空間 → クリップ空間 */
  projection: Mat4;
  eye: Vec3;
  /** 注視方向の単位ベクトル。平行投影の背面判定に使う */
  forward: Vec3;
  near: number;
}

/**
 * ワールドの点を画面の CSS px へ。**カメラの後ろなら null。**
 *
 * `paint` が面に対してやっていることを 1 点ぶんだけ切り出したもの。
 * バッジのように「面ではないが 3D に置いてあるもの」を出すのに要る。
 */
export function projectPoint(view: View, p: Vec3, width: number, height: number): Vec | null {
  const c = transformPoint(view.view, p);
  // near より手前は出さない。w ≈ 0 で座標が ±∞ に飛ぶ
  if (-c.z < view.near) return null;
  const q = transformPoint(view.projection, { x: c.x, y: c.y, z: c.z });
  if (!(Math.abs(q.w) > 1e-9)) return null;
  const x = ((q.x / q.w) * 0.5 + 0.5) * width;
  const y = (0.5 - (q.y / q.w) * 0.5) * height;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

export function viewProjection(cam: Camera3D, width: number, height: number): View {
  const aspect = aspectOf(width, height);
  const eye = cameraEye(cam);
  const view = mat4LookAt(eye, cam.target, UP);
  const projection =
    cam.mode === 'ortho'
      ? (() => {
          // 注視点の距離で透視と同じ画角になるように合わせる
          const halfHeight = cam.distance * Math.tan(cam.fovY / 2);
          return mat4Ortho(halfHeight * aspect, halfHeight, NEAR, FAR);
        })()
      : mat4Perspective(cam.fovY, aspect, NEAR, FAR);
  const forward = normalize3(sub3(cam.target, eye));
  return { matrix: mat4Multiply(projection, view), view, projection, eye, forward, near: NEAR };
}

export function orbit(cam: Camera3D, dxPx: number, dyPx: number): void {
  cam.yaw -= dxPx * 0.005;
  cam.pitch = clampPitch(cam.pitch - dyPx * 0.005);
}

/**
 * その場で見回す。**目の位置を動かさずに向きだけ変える。**
 *
 * `orbit` との違いは、**どちらが固定されるか**だけ。`orbit` は注視点を軸に
 * 目が回り、`lookAround` は目を軸に注視点が回る。一人称で要るのは後者で、
 * 前者を一人称の位置で使うと**目そのものが横へ滑る**（半径 1.5m の軌道カメラで
 * 100px ドラッグすると 742mm）。
 *
 * **カメラの型は増やさない**（このファイルの `flyOver` の注記と同じ理由）。
 * 目を先に押さえてから、向きを変えたぶんだけ注視点を置き直す。
 */
export function lookAround(cam: Camera3D, dxPx: number, dyPx: number): void {
  const eye = cameraEye(cam);
  // 向きは `orbit` と同じ係数・同じ符号にする。手触りを揃えるため
  cam.yaw -= dxPx * 0.005;
  cam.pitch = clampPitch(cam.pitch - dyPx * 0.005);
  aimFrom(cam, eye);
}

/**
 * 目を動かさずに方角だけ置き直す。
 *
 * 歩き始めに「空いているほう」を向くのに使う。`lookAround` と同じ不変量
 * （目が 1mm も動かない）を同じ 1 か所で保つ。
 */
export function faceYaw(cam: Camera3D, yaw: number): void {
  const eye = cameraEye(cam);
  cam.yaw = yaw;
  aimFrom(cam, eye);
}

/**
 * いまの `yaw`・`pitch` のまま、**目がここに来る**ように注視点を置き直す。
 *
 * 目は `target + dir(yaw, pitch) * distance` なので、逆に解くだけ。
 * 一人称の操作はどれも「目は動かさない」ので、その式をここに 1 つだけ置く。
 */
function aimFrom(cam: Camera3D, eye: Vec3): void {
  const cp = Math.cos(cam.pitch);
  cam.target = vec3(
    eye.x - cam.distance * cp * Math.cos(cam.yaw),
    eye.y - cam.distance * cp * Math.sin(cam.yaw),
    eye.z - cam.distance * Math.sin(cam.pitch),
  );
}

/**
 * 立っている場所を移す。**高さも向きも変えない。**
 *
 * 注視点ごと平行に動かすので、`yaw`・`pitch`・`distance` はそのまま——
 * 目の z も変わらない。ワイヤーの「移動位置をクリックすれば、**視点の xy 座標が
 * 移動する**」がそのままこの形。
 */
export function walkTo(cam: Camera3D, x: number, y: number): void {
  const eye = cameraEye(cam);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  cam.target = vec3(cam.target.x + (x - eye.x), cam.target.y + (y - eye.y), cam.target.z);
}

export function dolly(cam: Camera3D, factor: number): void {
  const next = cam.distance / factor;
  cam.distance = Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, Number.isFinite(next) ? next : cam.distance));
}

/** 画面のピクセル移動を、注視点の面での移動に直す */
export function pan(cam: Camera3D, dxPx: number, dyPx: number, height: number): void {
  if (height <= 0) return;
  const { right, up } = cameraBasis(cam);
  const perPx = (2 * cam.distance * Math.tan(cam.fovY / 2)) / height;
  const move = (v: Vec3, k: number) => {
    cam.target = vec3(cam.target.x + v.x * k, cam.target.y + v.y * k, cam.target.z + v.z * k);
  };
  move(right, -dxPx * perPx);
  move(up, dyPx * perPx);
}

/** 図面全体が入るように合わせる */
export function frameAll(cam: Camera3D, bounds: Bounds | null, wallHeight: number): void {
  if (!bounds) return;
  const w = bounds.max.x - bounds.min.x;
  const h = bounds.max.y - bounds.min.y;
  cam.target = vec3((bounds.min.x + bounds.max.x) / 2, (bounds.min.y + bounds.max.y) / 2, wallHeight / 2);
  const radius = Math.max(1000, Math.hypot(w, h, wallHeight) / 2);
  cam.distance = Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, (radius * 1.6) / Math.tan(cam.fovY / 2)));
}

/**
 * 視点の中心の取り方（ワイヤー 5 枚目の「各種中心モード」）。
 *
 * **カメラだけの話で、メッシュにもピックにも触らない。** 回す中心
 * （＝注視点）をどこに置くかが変わるだけ。
 */
export type OrbitCenter = 'all' | 'selection' | 'pick' | 'origin';

export const ORBIT_CENTER_LABELS: Record<OrbitCenter, string> = {
  all: '全図形の中心',
  selection: '選択したものの中心',
  pick: 'クリックした位置',
  origin: '原点 (0,0,0)',
};

/** 注視点だけを動かす。距離と角度はそのまま＝見ている向きは変わらない */
export function lookAt(cam: Camera3D, target: Vec3): void {
  cam.target = { ...target };
}

/**
 * 回る中心だけを移し、**目の位置は動かさない。**
 *
 * `lookAt` は注視点を置き換えるだけなので、目の位置は注視点から
 * `distance`・`yaw`・`pitch` で導かれる——**注視点を動かすと目も同じだけ飛ぶ**。
 * 「ここを中心に回す」つもりで押すたびに視点が飛ぶのはこれが理由で、
 * 歩いている位置も 1 回のドラッグで失われていた。
 *
 * 目の位置から新しい中心への向きと距離を取り直せば、見えている絵は
 * 1 ピクセルも変わらず、回る軸だけが移る。
 */
export function pivotAround(cam: Camera3D, at: Vec3): void {
  const eye = cameraEye(cam);
  const dx = eye.x - at.x;
  const dy = eye.y - at.y;
  const dz = eye.z - at.z;
  const dist = Math.hypot(dx, dy, dz);
  // 目の位置そのものを中心にはできない（向きが決まらない）
  if (!Number.isFinite(dist) || dist < MIN_DISTANCE) return;
  cam.target = { ...at };
  cam.distance = Math.min(MAX_DISTANCE, dist);
  cam.yaw = Math.atan2(dy, dx);
  cam.pitch = clampPitch(Math.asin(dz / dist));
}

/**
 * フライオーバー（歩き回る視点）。
 *
 * **目線の高さに下ろして、注視点を前方に置く。** 軌道カメラのまま
 * `pitch` を水平近くにして距離を詰めれば、同じ仕掛けで歩いている絵になる。
 * 別のカメラの型は作らない——投影・クリップ・ソートの経路を 2 つ持つと、
 * 片方だけ直す事故が起きる。
 */
export function flyOver(cam: Camera3D, at: Vec3, eyeHeight: number): void {
  cam.target = vec3(at.x, at.y, eyeHeight);
  cam.pitch = 0;
  cam.distance = Math.max(MIN_DISTANCE, 1500);
}

/**
 * カメラを外から読み書きするための形。
 *
 * **ワイヤーの「AI パース」の欄そのもの** ——カメラ位置（Eye）・ターゲット
 * 位置（Look-at）・画角。MiniCAD が出すのはここまでで、レンダリングは
 * しない（実行時依存ゼロと正面衝突する）。ウォークスルーも同じ形で渡す。
 *
 * **ロール（傾き）は持たない。** 上向きはいつも +z で、カメラが傾くことが
 * 無いので、ワイヤーの言う「カメラを水平に保つ補正」は既に満たしている。
 * **「2 点透視（垂直補正）」は持っていない** ——縦線を常に垂直に保つには
 * 投影の中心をずらした錐台が要り、`screenRay` と当たり判定も一緒に
 * 作り直すことになる。
 */
export interface CameraParams {
  /** カメラ位置 (mm) */
  eye: Vec3;
  /** 注視点 (mm) */
  target: Vec3;
  /** 垂直画角（度）。0〜90 */
  fovDeg: number;
  mode: 'perspective' | 'ortho';
}

export function cameraParams(cam: Camera3D): CameraParams {
  return {
    eye: cameraEye(cam),
    target: { ...cam.target },
    fovDeg: (cam.fovY * 180) / Math.PI,
    mode: cam.mode,
  };
}

/**
 * 外から来た値をカメラに当てる。
 *
 * 軌道カメラなので、眼と注視点から距離・方位角・仰角に直す。
 * 真上・真下は `lookAt` が NaN になるので、`PITCH_LIMIT` の内側に収める。
 */
export function applyCameraParams(cam: Camera3D, p: Partial<CameraParams>): void {
  if (p.target) cam.target = { ...p.target };
  if (p.fovDeg !== undefined && Number.isFinite(p.fovDeg)) {
    const deg = Math.min(90, Math.max(1, p.fovDeg));
    cam.fovY = (deg * Math.PI) / 180;
  }
  if (p.mode) cam.mode = p.mode;
  if (p.eye) {
    const d = sub3(p.eye, cam.target);
    const flat = Math.hypot(d.x, d.y);
    cam.distance = Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, Math.hypot(flat, d.z)));
    cam.yaw = Math.atan2(d.y, d.x);
    cam.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, Math.atan2(d.z, flat)));
  }
}

export const cameraRight = (cam: Camera3D): Vec3 => cameraBasis(cam).right;

export { scale3 };
