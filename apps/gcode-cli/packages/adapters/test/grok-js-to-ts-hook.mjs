/**
 * resolve hook：`.js` 说明符解析失败时回退同名 `.ts`。
 *
 * 只在正常解析抛错（模块不存在）时介入，不影响任何真实存在的 `.js`
 * 目标（含 node_modules 与其他包的构建产物）。
 */
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context)
  } catch (error) {
    if (specifier.endsWith('.js')) {
      return next(`${specifier.slice(0, -3)}.ts`, context)
    }
    throw error
  }
}
