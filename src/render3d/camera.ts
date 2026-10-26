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

export const cameraRight = (cam: Camera3D): Vec3 => cameraBasis(cam).right;

export { scale3 };
