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
process.stdout.write('Generated application icons from docs/assets/logo.svg.\n');
