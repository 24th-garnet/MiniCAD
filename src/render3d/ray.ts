import { aspectOf, cameraBasis, type Camera3D } from './camera.ts';
import { add3, normalize3, scale3, vec3, type Vec3 } from './mat4.ts';

/**
 * 画面の点からワールドのレイを作る。3D で拾う／動かすの入口。
 *
 * **逆行列は足さない。** `mat4Invert` は 16 項の余因子展開で、呼ぶのはここ 1 箇所。
 * 符号を 1 つ間違えると**もっともらしく少しずれたレイ**が出て、既存のどのテストも
 * 捕まえない（「端のほうで拾えない」という形で後から効く）。軌道カメラは
 * 閉じた形なので、基底から解析的に組むほうが短く、確かめやすい。
 *
 * **`viewProjection` と同じ式を共有する。** `aspectOf` と `cameraBasis` を
 * 両方が使うので、片方だけ直してずれる余地が無い。ずれていないことは
 * 「投影して画面座標に直し、そこからレイを作ると元の点に戻る」で見ている。
 *
 * **受けるのは CSS ピクセル。** `paint` は座標に DPR を掛けるが、ポインタから
 * 来るのは `getBoundingClientRect()` 由来の CSS ピクセルなので、ここでは掛けない。
 */
export interface Ray3 {
  origin: Vec3;
  /** 単位ベクトル */
  direction: Vec3;
}

export function screenRay(cam: Camera3D, x: number, y: number, width: number, height: number): Ray3 {
  // paint の逆。x_px = (ndcX*0.5 + 0.5) * width、y_px = (0.5 - ndcY*0.5) * height
  const ndcX = width > 0 ? (x / width) * 2 - 1 : 0;
  const ndcY = height > 0 ? 1 - (y / height) * 2 : 0;

  const { eye, forward, right, up } = cameraBasis(cam);
  const aspect = aspectOf(width, height);
  const tanHalf = Math.tan(cam.fovY / 2);

  if (cam.mode === 'ortho') {
    // 平行投影は視線の向きが画面中で一定で、出る位置だけがずれる。
    // 半分の高さは viewProjection の mat4Ortho と同じ `distance * tan(fovY/2)`
    const halfH = cam.distance * tanHalf;
    const origin = add3(
      eye,
      add3(scale3(right, ndcX * halfH * aspect), scale3(up, ndcY * halfH)),
    );
    return { origin, direction: forward };
  }

  const dir = add3(
    forward,
    add3(scale3(right, ndcX * aspect * tanHalf), scale3(up, ndcY * tanHalf)),
  );
  return { origin: eye, direction: normalize3(dir, vec3(0, 0, -1)) };
}

/** レイ上の点 */
export const rayPointAt = (ray: Ray3, t: number): Vec3 => add3(ray.origin, scale3(ray.direction, t));
