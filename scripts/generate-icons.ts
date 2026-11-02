import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const source = await readFile(new URL('../docs/assets/logo.svg', import.meta.url));
const directory = new URL('../apps/desktop/build/', import.meta.url);
await mkdir(directory, { recursive: true });

await sharp(source)
  .resize(512, 512)
  .png()
  .toFile(fileURLToPath(new URL('icon.png', directory)));

const sizes = [16, 24, 32, 48, 64, 128, 256];

const images = await Promise.all(
  sizes.map(size => sharp(source).resize(size, size).png().toBuffer()),
);

const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);

let offset = header.length;

for (const [index, image] of images.entries()) {
  const entry = 6 + index * 16;
  const dimension = sizes[index]! % 256;
  header.writeUInt8(dimension, entry);
  header.writeUInt8(dimension, entry + 1);
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(image.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += image.length;
}

await writeFile(new URL('icon.ico', directory), Buffer.concat([header, ...images]));
const extensionDirectory = new URL('../apps/extension/public/icon/', import.meta.url);
await mkdir(extensionDirectory, { recursive: true });
await Promise.all(
  [16, 32, 48, 128].map(size =>
    sharp(source)
      .resize(size, size)
      .flatten({ background: '#111111' })
      .png()
      .toFile(fileURLToPath(new URL(`${size}.png`, extensionDirectory))),
  ),
);

const androidResources = new URL(
  '../apps/mobile/App_Resources/Android/src/main/res/',
  import.meta.url,
);

const densities = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };

await Promise.all(
  Object.entries(densities).map(async ([density, size]) => {
    const directory = new URL(`mipmap-${density}/`, androidResources);
    await mkdir(directory, { recursive: true });
    await sharp(source)
      .resize(size, size)
      .png()
      .toFile(fileURLToPath(new URL('ic_launcher.png', directory)));
  }),
);

const drawableDirectory = new URL('drawable-nodpi/', androidResources);
await mkdir(drawableDirectory, { recursive: true });
await sharp(source)
  .resize(432, 432)
  .png()
  .toFile(fileURLToPath(new URL('ic_launcher_foreground.png', drawableDirectory)));

// 通知栏只读取透明度：由同一份 Logo 的明暗区域生成单色蒙版。
const pixels = await sharp(source)
  .resize(96, 96)
  .flatten({ background: '#111111' })
  .greyscale()
  .raw()
  .toBuffer();

const mask = Buffer.alloc(96 * 96 * 4);

for (let index = 0; index < pixels.length; index++) {
  mask[index * 4] = 214;
  mask[index * 4 + 1] = 214;
  mask[index * 4 + 2] = 214;
  mask[index * 4 + 3] = Math.max(0, Math.min(255, Math.round(((pixels[index]! - 17) * 255) / 197)));
}

await sharp(mask, { raw: { width: 96, height: 96, channels: 4 } })
  .png()
  .toFile(fileURLToPath(new URL('ic_notification.png', drawableDirectory)));

const adaptiveDirectory = new URL('mipmap-anydpi-v26/', androidResources);
await mkdir(adaptiveDirectory, { recursive: true });
await writeFile(
  new URL('ic_launcher.xml', adaptiveDirectory),
  `<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <background android:drawable="@color/bplaylist_icon_background" />
  <foreground android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>\n`,
);

process.stdout.write('Generated application icons from docs/assets/logo.svg.\n');
