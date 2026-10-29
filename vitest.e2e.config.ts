import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

/** 用例文件按文件名顺序执行（NN- 编号决定顺序），不按历史耗时重排 */
class ByNameSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return [...files].sort((a, b) => (a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : 0));
  }
}

// e2e 独立配置：真实启动 Electron 实例，文件之间串行、单 worker，不重试。
// 用线程而不是子进程跑用例：Node 偶发原生崩溃（0xC0000409）时，子进程模式只报「Worker exited unexpectedly」
// 并丢掉该文件；线程模式下整个 vitest 进程以 NTSTATUS 退出码结束，run.js 据此识别并整轮重跑
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.e2e.ts'],
    pool: 'threads',
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    retry: 0,
    sequence: { sequencer: ByNameSequencer, shuffle: false },
    reporters: ['verbose'],
  },
});
