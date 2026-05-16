#!/usr/bin/env bun

import { $, type BunPlugin } from "bun"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

import { Script } from "@opencode-ai/script"
import pkg from "../package.json"

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const skipInstall = process.argv.includes("--skip-install")
const sourcemapsFlag = process.argv.includes("--sourcemaps")
const plugin = createSolidTransformPlugin()
const skipEmbedWebUi = process.argv.includes("--skip-embed-web-ui")

const createEmbeddedWebUIBundle = async () => {
  console.log(`Building Web UI to embed in the binary`)
  const appDir = path.join(import.meta.dirname, "../../app")
  const dist = path.join(appDir, "dist")
  await $`OPENCODE_CHANNEL=${Script.channel} bun run --cwd ${appDir} build`
  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dist })))
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.endsWith(".map"))
    .sort()
  const imports = files.map((file, i) => {
    const spec = path.relative(dir, path.join(dist, file)).replaceAll("\\", "/")
    return `import file_${i} from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)} with { type: "file" };`
  })
  const entries = files.map((file, i) => `  ${JSON.stringify(file)}: file_${i},`)
  return [
    `// Import all files as file_$i with type: "file"`,
    ...imports,
    `// Export with original mappings`,
    `export default {`,
    ...entries,
    `}`,
  ].join("\n")
}

const embeddedFileMap = skipEmbedWebUi ? null : await createEmbeddedWebUIBundle()

const opentuiLoong64Sidecar = "libopentui.so"
const parcelWatcherLoong64Sidecar = "parcel-watcher.node"

type RootPackageJson = {
  workspaces?: {
    catalog?: Record<string, string>
  }
}

const rootPackageJson: RootPackageJson = JSON.parse(fs.readFileSync(path.resolve(dir, "../..", "package.json"), "utf8"))

const expectedOpenTUIVersion = () => {
  const version = pkg.dependencies["@opentui/core"]
  return version === "catalog:" ? rootPackageJson.workspaces?.catalog?.["@opentui/core"] : version
}

const opentuiLoong64LibraryCandidates = () => {
  const nativePackagePath = "node_modules/@opentui/core-linux-loong64"
  const bunNativePackagePath = "node_modules/.bun/node_modules/@opentui/core-linux-loong64"
  return [
    { lib: process.env.OPENTUI_LOONG64_LIB },
    {
      lib: path.resolve(dir, "../../../opentui/packages/core", nativePackagePath, opentuiLoong64Sidecar),
      packageJson: path.resolve(dir, "../../../opentui/packages/core", nativePackagePath, "package.json"),
    },
    {
      lib: path.resolve(dir, bunNativePackagePath, opentuiLoong64Sidecar),
      packageJson: path.resolve(dir, bunNativePackagePath, "package.json"),
    },
    {
      lib: path.resolve(dir, nativePackagePath, opentuiLoong64Sidecar),
      packageJson: path.resolve(dir, nativePackagePath, "package.json"),
    },
    {
      lib: path.resolve(dir, "../../", bunNativePackagePath, opentuiLoong64Sidecar),
      packageJson: path.resolve(dir, "../../", bunNativePackagePath, "package.json"),
    },
    {
      lib: path.resolve(dir, "../../", nativePackagePath, opentuiLoong64Sidecar),
      packageJson: path.resolve(dir, "../../", nativePackagePath, "package.json"),
    },
  ].filter((candidate): candidate is { lib: string; packageJson?: string } => Boolean(candidate.lib))
}

const findOpenTUILoong64Library = () => {
  const expected = expectedOpenTUIVersion()
  for (const candidate of opentuiLoong64LibraryCandidates()) {
    if (!fs.existsSync(candidate.lib)) continue
    if (candidate.packageJson && fs.existsSync(candidate.packageJson)) {
      const nativePackageJson = JSON.parse(fs.readFileSync(candidate.packageJson, "utf8"))
      if (expected && nativePackageJson.version !== expected) {
        console.warn(
          `Using ${candidate.lib}: @opentui/core-linux-loong64 is ${nativePackageJson.version}, expected ${expected}`,
        )
      }
    }
    return fs.realpathSync(candidate.lib)
  }
}

const openTUISourceCandidates = () =>
  [
    process.env.OPENTUI_SOURCE_DIR,
    path.resolve(dir, "../../../opentui"),
    path.resolve(dir, "../../opentui"),
    path.resolve(process.cwd(), "opentui"),
  ]
    .filter(Boolean)
    .filter((candidate): candidate is string => fs.existsSync(path.join(candidate, "packages/core/package.json")))

const buildOpenTUILoong64Library = async () => {
  for (const sourceRoot of openTUISourceCandidates()) {
    const corePackageJson = JSON.parse(fs.readFileSync(path.join(sourceRoot, "packages/core/package.json"), "utf8"))
    const expected = expectedOpenTUIVersion()
    if (expected && corePackageJson.version !== expected) {
      console.warn(
        `Building OpenTUI source at ${sourceRoot}: @opentui/core is ${corePackageJson.version}, expected ${expected}`,
      )
    }

    console.log(`Building @opentui/core-linux-loong64 from ${sourceRoot}`)
    await $`bun run --cwd ${path.join(sourceRoot, "packages/core")} build:native`

    const lib = findOpenTUILoong64Library()
    if (lib) return lib
  }
}

const resolveOpenTUILoong64Library = async () => {
  const lib = findOpenTUILoong64Library() ?? (await buildOpenTUILoong64Library())
  if (!lib) {
    throw new Error(
      [
        "Unable to find @opentui/core-linux-loong64/libopentui.so.",
        "Set OPENTUI_LOONG64_LIB or OPENTUI_SOURCE_DIR, or place a loong64-enabled OpenTUI checkout next to opencode.",
      ].join(" "),
    )
  }
  return lib
}

const createOpenTUILoong64NativePlugin = (sidecar: string): BunPlugin => ({
  name: "opencode-opentui-loong64-native-sidecar",
  setup(build) {
    build.onResolve({ filter: /^@opentui\/core-linux-loong64(?:\/.*)?$/ }, () => ({
      path: "@opentui/core-linux-loong64",
      namespace: "opencode-opentui-native-sidecar",
    }))
    build.onLoad({ filter: /.*/, namespace: "opencode-opentui-native-sidecar" }, () => ({
      loader: "js",
      contents: [
        'import path from "path"',
        `export default path.join(path.dirname(process.execPath), ${JSON.stringify(sidecar)})`,
      ].join("\n"),
    }))
  },
})

const parcelWatcherLoong64BindingCandidates = () =>
  [
    process.env.PARCEL_WATCHER_LOONG64_NODE,
    path.resolve(dir, "node_modules/@parcel/watcher/build/Release/watcher.node"),
    path.resolve(dir, "../../node_modules/@parcel/watcher/build/Release/watcher.node"),
  ]
    .filter(Boolean)
    .filter((candidate): candidate is string => fs.existsSync(candidate))

const parcelWatcherSourceCandidates = () =>
  [
    path.resolve(dir, "node_modules/@parcel/watcher"),
    path.resolve(dir, "../../node_modules/@parcel/watcher"),
  ].filter((candidate) => fs.existsSync(path.join(candidate, "binding.gyp")))

const findParcelWatcherLoong64Binding = () => {
  for (const candidate of parcelWatcherLoong64BindingCandidates()) {
    return fs.realpathSync(candidate)
  }
}

const buildParcelWatcherLoong64Binding = async () => {
  for (const sourceRoot of parcelWatcherSourceCandidates()) {
    console.log(`Building @parcel/watcher linux-loong64-glibc binding from ${sourceRoot}`)
    await $`bun run build`.cwd(sourceRoot)

    const binding = findParcelWatcherLoong64Binding()
    if (binding) return binding
  }
}

const resolveParcelWatcherLoong64Binding = async () => {
  const binding = findParcelWatcherLoong64Binding() ?? (await buildParcelWatcherLoong64Binding())
  if (!binding) {
    throw new Error(
      [
        "Unable to find @parcel/watcher linux-loong64-glibc watcher.node.",
        "Set PARCEL_WATCHER_LOONG64_NODE or install/build @parcel/watcher on loong64 before packaging.",
      ].join(" "),
    )
  }
  return binding
}

const releaseAssetRepo = () => process.env.GH_REPO ?? "anomalyco/opencode"

const npmTarballName = (name: string, version: string) => `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`

const releaseAssetUrl = (name: string, version: string) =>
  `https://github.com/${releaseAssetRepo()}/releases/download/v${version}/${npmTarballName(name, version)}`

const packNpmPackage = async (packageDir: string) => {
  if (process.platform !== "win32") await $`chmod -R 755 .`.cwd(packageDir)
  await $`npm pack --pack-destination ${path.join(dir, "dist")} .`.cwd(packageDir)
}

const releaseAssets = async () =>
  (
    await Promise.all(
      ["*.zip", "*.tar.gz", "*.tgz"].map((pattern) =>
        Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: path.join(dir, "dist") })),
      ),
    )
  )
    .flat()
    .sort()
    .map((file) => path.join(dir, "dist", file))

const createNpmInstallerPackage = async (binaries: Record<string, string>) => {
  const installerDir = path.join(dir, "dist", `${pkg.name}-ai`)
  await $`rm -rf ${installerDir}`
  await $`mkdir -p ${path.join(installerDir, "bin")}`
  await $`cp -r ${path.join(dir, "bin")} ${installerDir}`
  await $`cp ${path.join(dir, "script/postinstall.mjs")} ${path.join(installerDir, "postinstall.mjs")}`
  await Bun.file(path.join(installerDir, "LICENSE")).write(await Bun.file(path.join(dir, "../../LICENSE")).text())
  await Bun.file(path.join(installerDir, "package.json")).write(
    JSON.stringify(
      {
        name: `${pkg.name}-ai`,
        version: Script.version,
        license: pkg.license,
        bin: {
          [pkg.name]: `./bin/${pkg.name}`,
        },
        scripts: {
          postinstall: "bun ./postinstall.mjs || node ./postinstall.mjs",
        },
        optionalDependencies: Object.fromEntries(
          Object.entries(binaries).map(([name, version]) => [name, releaseAssetUrl(name, version)]),
        ),
      },
      null,
      2,
    ),
  )
  await packNpmPackage(installerDir)
}

const allTargets: {
  os: string
  arch: "arm64" | "x64" | "loong64"
  abi?: "musl"
  avx2?: false
}[] = [
  {
    os: "linux",
    arch: "arm64",
  },
  {
    os: "linux",
    arch: "loong64",
  },
  {
    os: "linux",
    arch: "x64",
  },
  {
    os: "linux",
    arch: "x64",
    avx2: false,
  },
  {
    os: "linux",
    arch: "arm64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
    avx2: false,
  },
  {
    os: "darwin",
    arch: "arm64",
  },
  {
    os: "darwin",
    arch: "x64",
  },
  {
    os: "darwin",
    arch: "x64",
    avx2: false,
  },
  {
    os: "win32",
    arch: "arm64",
  },
  {
    os: "win32",
    arch: "x64",
  },
  {
    os: "win32",
    arch: "x64",
    avx2: false,
  },
]

const targets = singleFlag
  ? allTargets.filter((item) => {
      if (item.os !== process.platform || item.arch !== process.arch) {
        return false
      }

      // When building for the current platform, prefer a single native binary by default.
      // Baseline binaries require additional Bun artifacts and can be flaky to download.
      if (item.avx2 === false) {
        return baselineFlag
      }

      // also skip abi-specific builds for the same reason
      if (item.abi !== undefined) {
        return false
      }

      return true
    })
  : allTargets

await $`rm -rf dist`

const binaries: Record<string, string> = {}
if (!skipInstall) {
  await $`bun install --os="*" --cpu="*" @opentui/core@${pkg.dependencies["@opentui/core"]}`
  await $`bun install --os="*" --cpu="*" @parcel/watcher@${pkg.dependencies["@parcel/watcher"]}`
  await $`bun install --os="*" --cpu="*" @ff-labs/fff-bun@${pkg.dependencies["@ff-labs/fff-bun"]}`
}
for (const item of targets) {
  const name = [
    pkg.name,
    // changing to win32 flags npm for some reason
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi === undefined ? undefined : item.abi,
  ]
    .filter(Boolean)
    .join("-")
  console.log(`building ${name}`)
  await $`mkdir -p dist/${name}/bin`

  const localPath = path.resolve(dir, "node_modules/@opentui/core/parser.worker.js")
  const rootPath = path.resolve(dir, "../../node_modules/@opentui/core/parser.worker.js")
  const parserWorker = fs.realpathSync(fs.existsSync(localPath) ? localPath : rootPath)
  const workerPath = "./src/cli/tui/worker.ts"
  const opentuiLoong64Library =
    item.os === "linux" && item.arch === "loong64" ? await resolveOpenTUILoong64Library() : undefined
  const parcelWatcherLoong64Binding =
    item.os === "linux" && item.arch === "loong64" && (item.abi ?? "glibc") === "glibc"
      ? await resolveParcelWatcherLoong64Binding()
      : undefined

  // Use platform-specific bunfs root path based on target OS
  const bunfsRoot = item.os === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"
  const workerRelativePath = path.relative(dir, parserWorker).replaceAll("\\", "/")

  await Bun.build({
    conditions: ["bun", "node"],
    tsconfig: "./tsconfig.json",
    plugins: [plugin, ...(opentuiLoong64Library ? [createOpenTUILoong64NativePlugin(opentuiLoong64Sidecar)] : [])],
    external: ["node-gyp"],
    format: "esm",
    minify: item.arch !== "loong64",
    sourcemap: sourcemapsFlag ? "linked" : "none",
    splitting: item.arch !== "loong64",
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: name.replace(pkg.name, "bun") as any,
      outfile: `dist/${name}/bin/opencode`,
      execArgv: [
        `--user-agent=opencode/${Script.version}`,
        "--use-system-ca",
        ...(item.arch === "loong64" ? ["--jsc:useDFGJIT=false", "--jsc:useFTLJIT=false"] : []),
        "--",
      ],
      windows: {},
    },
    files: embeddedFileMap ? { "opencode-web-ui.gen.ts": embeddedFileMap } : {},
    entrypoints: ["./src/index.ts", parserWorker, workerPath, ...(embeddedFileMap ? ["opencode-web-ui.gen.ts"] : [])],
    define: {
      FFF_LIBC: JSON.stringify(item.abi === "musl" ? "musl" : "gnu"),
      OPENCODE_VERSION: `'${Script.version}'`,
      OPENCODE_MODELS_DEV: generated.modelsData,
      OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + workerRelativePath,
      OPENCODE_WORKER_PATH: workerPath,
      OPENCODE_CHANNEL: `'${Script.channel}'`,
      OPENCODE_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "",
      ...(item.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify(item.abi ?? "glibc") } : {}),
    },
  })

  if (opentuiLoong64Library) {
    await fs.promises.copyFile(opentuiLoong64Library, path.join(dir, "dist", name, "bin", opentuiLoong64Sidecar))
  }

  if (parcelWatcherLoong64Binding) {
    await fs.promises.copyFile(
      parcelWatcherLoong64Binding,
      path.join(dir, "dist", name, "bin", parcelWatcherLoong64Sidecar),
    )
  }

  // Smoke test: only run if binary is for current platform
  if (item.os === process.platform && item.arch === process.arch && !item.abi) {
    const binaryPath = `dist/${name}/bin/opencode`
    console.log(`Running smoke test: ${binaryPath} --version`)
    try {
      const versionOutput = await $`${binaryPath} --version`.text()
      console.log(`Smoke test passed: ${versionOutput.trim()}`)
    } catch (e) {
      console.error(`Smoke test failed for ${name}:`, e)
      process.exit(1)
    }
  }

  await $`rm -rf ./dist/${name}/bin/tui`
  await Bun.file(`dist/${name}/package.json`).write(
    JSON.stringify(
      {
        name,
        version: Script.version,
        preferUnplugged: true,
        os: [item.os],
        cpu: [item.arch],
        ...(item.abi ? { libc: [item.abi] } : {}),
      },
      null,
      2,
    ),
  )
  binaries[name] = Script.version
}

if (Script.release) {
  for (const key of Object.keys(binaries)) {
    if (key.includes("linux")) {
      await $`tar -czf ../../${key}.tar.gz *`.cwd(`dist/${key}/bin`)
    } else {
      await $`zip -r ../../${key}.zip *`.cwd(`dist/${key}/bin`)
    }
    await packNpmPackage(path.join(dir, "dist", key))
  }
  await createNpmInstallerPackage(binaries)
  await $`gh release upload v${Script.version} ${await releaseAssets()} --clobber --repo ${releaseAssetRepo()}`
}

export { binaries }
