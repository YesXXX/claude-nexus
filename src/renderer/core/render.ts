/**
 * 同步渲染调度。入口用 setRenderer() 注入整体渲染函数。
 * render() 同步执行，调用返回时界面已更新，调用方可以紧接着聚焦或读取 DOM；
 * 渲染过程中再次调用时不嵌套执行，而是在本轮结束后补一轮。
 * requestRender() 按动画帧合并多次请求，只给高频更新的功能使用。
 */

let renderer: (() => void) | null = null;
let rendering = false;
let rerun = false;
let frame = 0;

export function setRenderer(fn: () => void): void {
  renderer = fn;
}

export function render(): void {
  if (!renderer) return;
  if (rendering) { rerun = true; return; }
  rendering = true;
  try {
    do {
      rerun = false;
      renderer();
    } while (rerun);
  } finally {
    rendering = false;
    rerun = false;
  }
}

export function requestRender(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    render();
  });
}
