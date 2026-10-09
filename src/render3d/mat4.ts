/**
 * 4x4 行列。**列優先** (`m[col * 4 + row]`) で持つ。
 * 平行移動は `m[12]`, `m[13]`, `m[14]` に入る。
 *
 * `core/transform.ts` の 2x3 とは別物。あちらは Canvas の `setTransform` と同じ
 * 並びの「平面のアフィン」で、合成の約束も違う。無理に揃えない。
 * 列優先にしているのは、`lookAt` や `glFrustum` の典型的な導出がすべて列優先で、
 * 写経と検算のコストが最小になるため。
 *
 * DOM にも Canvas にも触らないので、node から直接テストできる。
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type Mat4 = readonly number[];

export const vec3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

export const add3 = (a: Vec3, b: Vec3): Vec3 => vec3(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub3 = (a: Vec3, b: Vec3): Vec3 => vec3(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale3 = (a: Vec3, k: number): Vec3 => vec3(a.x * k, a.y * k, a.z * k);
export const dot3 = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross3 = (a: Vec3, b: Vec3): Vec3 =>
  vec3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const length3 = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);

/** 長さ 0 のときは渡した既定を返す。ここで NaN を作らないのが要点 */
export function normalize3(a: Vec3, fallback: Vec3 = vec3(0, 0, 1)): Vec3 {
  const len = length3(a);
  return len > 1e-12 ? scale3(a, 1 / len) : fallback;
}

export const mat4Identity = (): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** `a ∘ b`。b を先に適用する */
export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

export const mat4Translate = (x: number, y: number, z: number): Mat4 => [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  x, y, z, 1,
];

/** 視点を原点に、注視方向を −z に向ける */
export function mat4LookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const f = normalize3(sub3(target, eye));
  // forward と up が平行だと外積が 0 になる。呼び出し側で pitch をクランプしているが保険を置く
  const s = normalize3(cross3(f, up), vec3(1, 0, 0));
  const u = cross3(s, f);
  return [
    s.x, u.x, -f.x, 0,
    s.y, u.y, -f.y, 0,
    s.z, u.z, -f.z, 0,
    -dot3(s, eye), -dot3(u, eye), dot3(f, eye), 1,
  ];
}

export function mat4Perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  return [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ];
}

/** 平行投影。`w` が常に 1 になるだけで、以降の処理は透視と同じ経路を通る */
export function mat4Ortho(halfWidth: number, halfHeight: number, near: number, far: number): Mat4 {
  return [
    1 / halfWidth, 0, 0, 0,
    0, 1 / halfHeight, 0, 0,
    0, 0, -2 / (far - near), 0,
    0, 0, -(far + near) / (far - near), 1,
  ];
}

export interface Projected {
  x: number;
  y: number;
  z: number;
  w: number;
}

export function transformPoint(m: Mat4, p: Vec3): Projected {
  return {
    x: m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12],
    y: m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13],
    z: m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14],
    w: m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15],
  };
}
