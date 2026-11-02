import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mobile = join(root, 'apps/mobile');

const sdk =
  process.env.ANDROID_HOME ||
  process.env.ANDROID_SDK_ROOT ||
  join(process.env.LOCALAPPDATA || '', 'Android/Sdk');

const ndkRoot = join(sdk, 'ndk');
const ndk = process.env.ANDROID_NDK_HOME || join(ndkRoot, readdirSync(ndkRoot).sort().at(-1)!);
const abi = process.env.BPLAYLIST_ANDROID_ABI || 'arm64-v8a';

const targets: Record<string, string> = {
  'arm64-v8a': 'aarch64-linux-android',
  x86_64: 'x86_64-linux-android',
  x86: 'i686-linux-android',
};

const target = targets[abi];

if (!target) {
  throw new Error(`Unsupported Android ABI: ${abi}`);
}

const linkerKey = `CARGO_TARGET_${target.toUpperCase().replaceAll('-', '_')}_LINKER`;

const toolchain = join(
  ndk,
  'toolchains/llvm/prebuilt',
  process.platform === 'win32' ? 'windows-x86_64' : 'linux-x86_64',
  'bin',
);

const compiler = join(
  toolchain,
  process.platform === 'win32' ? `${target}26-clang.cmd` : `${target}26-clang`,
);

const studioJdk = 'C:/Program Files/Android/Android Studio/jbr';

const environment = {
  ...process.env,
  ANDROID_HOME: sdk,
  ANDROID_SDK_ROOT: sdk,
  JAVA_HOME: process.env.JAVA_HOME || (existsSync(studioJdk) ? studioJdk : ''),
  [linkerKey]: compiler,
  [`CC_${target.replaceAll('-', '_')}`]: compiler,
  [`AR_${target.replaceAll('-', '_')}`]: join(
    toolchain,
    process.platform === 'win32' ? 'llvm-ar.exe' : 'llvm-ar',
  ),
};

function run(command: string, args: string[], cwd = root) {
  const result = spawnSync(command, args, { cwd, env: environment, stdio: 'inherit' });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run(process.execPath, [
  join(root, 'node_modules/vite-plus/bin/vpx'),
  join(root, 'scripts/generate-icons.ts'),
]);

run('cargo', [
  'build',
  '--locked',
  '--manifest-path',
  'crates/mobile-core/Cargo.toml',
  '--target',
  target,
  '--release',
  '--lib',
]);
const libraries = join(mobile, `App_Resources/Android/src/main/jniLibs/${abi}`);
mkdirSync(libraries, { recursive: true });
copyFileSync(
  join(root, `crates/mobile-core/target/${target}/release/libbplaylist_mobile.so`),
  join(libraries, 'libbplaylist_mobile.so'),
);

const cli = join(mobile, 'node_modules/nativescript/bin/tns');
const operation = process.argv[2] === 'run' ? 'run' : 'build';
run(
  process.execPath,
  [cli, operation, 'android', '--no-hmr', `--gradleArgs=-Pabis=${abi}`],
  mobile,
);

if (operation === 'build') {
  const artifacts = join(root, 'release');
  const output = join(artifacts, `bplaylist-android-${abi}-debug.apk`);
  mkdirSync(artifacts, { recursive: true });
  copyFileSync(join(mobile, 'platforms/android/app/build/outputs/apk/debug/app-debug.apk'), output);
  process.stdout.write(`Android APK: ${output}\n`);
}
