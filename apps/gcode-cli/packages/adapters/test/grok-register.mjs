/**
 * node:test harness 入口：装载 .js→.ts 说明符映射 hook。
 *
 * src/ 内部相对导入按 tsc NodeNext 约定写 `.js`（与构建产物一致）；node
 * 原生类型剥离直接跑测试时，本 hook 把指向不存在 `.js` 文件的说明符回退
 * 到同名 `.ts` 源文件。仅测试 harness 使用，不参与构建。
 */
import { register } from 'node:module'

register('./grok-js-to-ts-hook.mjs', import.meta.url)
