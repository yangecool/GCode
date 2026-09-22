/**
 * resolve hook：相对 `.js` 说明符解析失败时回退同名 `.ts`。
 *
 * 仓库运行时约定（packages/shared 等 exports 直指 src/*.ts）要求
 * --experimental-transform-types（参数属性/枚举可编译）；相对导入仍写 `.js`
 * （tsc NodeNext 约定），由本 hook 在测试运行时映射回源文件。
 */
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context)
  } catch (error) {
    const isRelative = specifier.startsWith('./') || specifier.startsWith('../')
    if (isRelative && specifier.endsWith('.js')) {
      return next(`${specifier.slice(0, -3)}.ts`, context)
    }
    throw error
  }
}
