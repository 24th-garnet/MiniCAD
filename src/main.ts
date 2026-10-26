import './style.css';
import { loadLocal } from './io/scene.ts';
import { sampleScene } from './io/sample.ts';
import { App } from './ui/app.ts';

const host = document.getElementById('app');
if (!host) throw new Error('#app が見つかりません');
const app = new App(host);
// 前回の続きがあれば復元し、初回はサンプル間取りで始める
app.loadScene(loadLocal() ?? sampleScene());

// 開発時だけ、コンソールや自動テストから中身を触れるようにしておく
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).minicad = app;
}
