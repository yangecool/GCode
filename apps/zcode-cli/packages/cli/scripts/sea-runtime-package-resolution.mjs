import { createRequire } from "node:module";
import { access, readFile } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";

export function placeRuntimePackage({ packageName, packageDirectory, fromAssetPath, placements }) {
  // 原收集器仅按包名去重，把 contracts 的 Zod 3 和 shared 的 Zod 4 压成同一个包。
  // 按消费者的 Node 查找顺序复用同一物理包；冲突版本放入消费者自己的 node_modules。
  let directory = fromAssetPath;
  while (true) {
    const candidate = posix.join(directory, "node_modules", packageName);
    const existing = placements.get(candidate);
    if (existing) {
      if (existing === packageDirectory) return undefined;
      break;
    }
    if (directory === ".") break;
    directory = posix.dirname(directory);
  }
  const rootPath = posix.join("node_modules", packageName);
  const assetPath = placements.has(rootPath)
    ? posix.join(fromAssetPath, "node_modules", packageName)
    : rootPath;
  placements.set(assetPath, packageDirectory);
  return assetPath;
}

/** 解析 workspace 包的运行时入口文件；不存在返回 undefined。 */
const resolveWorkspaceEntry = async (directory) => {
  let pkg;
  try {
    pkg = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
  const dot = pkg?.exports?.["."];
  const candidates = [];
  if (typeof dot === "string") candidates.push(dot);
  else if (dot && typeof dot === "object") {
    for (const key of ["import", "require", "default"]) {
      const value = dot[key];
      if (typeof value === "string") candidates.push(value);
      else if (value && typeof value === "object" && typeof value.import === "string") {
        candidates.push(value.import);
      }
    }
  }
  if (typeof pkg?.main === "string") candidates.push(pkg.main);
  candidates.push("dist/index.js");
  for (const candidate of candidates) {
    if (await exists(resolve(directory, candidate))) return candidate;
  }
  return undefined;
};

export const resolveRuntimePackageDirectory = async ({
  fromDirectory,
  packageName,
  root,
  workspacePackageDirectories,
}) => {
  const workspacePackageDirectory = workspacePackageDirectories.get(packageName);
  if (workspacePackageDirectory) {
    const directory = workspacePackageDirectory;
    await assertPackageDirectory(packageName, directory);
    // 入口按包自己的 exports/main 解析：根仓 src-exported 包（@zcode/shared，
    // exports 直指 src/*.ts）在 node>=24（require TS 原生支持）下作为运行时
    // 资产同样合法；只有既无 exports 指向文件、又无 dist/index.js 才是未构建。
    const entry = await resolveWorkspaceEntry(directory);
    if (entry === undefined) {
      throw new Error(`Missing ${packageName} entry files. Run \`pnpm build\` before \`pnpm sea\`.`);
    }
    return directory;
  }

  const require = createRequire(resolve(fromDirectory ?? root, "package.json"));
  try {
    try {
      return dirname(require.resolve(`${packageName}/package.json`));
    } catch (error) {
      if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") {
        throw error;
      }
      return await findPackageRoot(require.resolve(packageName), packageName);
    }
  } catch (error) {
    const packageDirectory = await resolvePackageRootFromNodeModules({
      fromDirectory,
      packageName,
      root,
    });
    if (packageDirectory) {
      return packageDirectory;
    }
    throw new Error(
      `Missing SEA TUI runtime package ${packageName}. Run \`pnpm install\` and try again.`,
      {
        cause: error,
      },
    );
  }
};

const resolvePackageRootFromNodeModules = async ({ fromDirectory, packageName, root }) => {
  const packagePathSegments = packageName.split("/");

  for (const directory of ancestorDirectories(resolve(fromDirectory ?? root))) {
    const packageDirectory = resolve(directory, "node_modules", ...packagePathSegments);
    if (await exists(resolve(packageDirectory, "package.json"))) {
      return packageDirectory;
    }
  }

  return undefined;
};

function* ancestorDirectories(startDirectory) {
  let directory = startDirectory;

  while (true) {
    yield directory;
    const parentDirectory = dirname(directory);
    if (parentDirectory === directory) {
      return;
    }
    directory = parentDirectory;
  }
}

const findPackageRoot = async (entryPath, packageName) => {
  let directory = dirname(entryPath);

  while (directory !== dirname(directory)) {
    const packageJsonPath = resolve(directory, "package.json");
    if (await exists(packageJsonPath)) {
      const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
      if (packageJson.name === packageName) {
        return directory;
      }
    }
    directory = dirname(directory);
  }

  throw new Error(`Could not find package root for ${packageName} from ${entryPath}`);
};

const assertPackageDirectory = async (packageName, directory) => {
  if (!(await exists(resolve(directory, "package.json")))) {
    throw new Error(`Missing package.json for ${packageName} at ${directory}`);
  }
};

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
