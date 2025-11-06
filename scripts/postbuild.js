import { mkdirSync, copyFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const distDir = path.resolve(__dirname, '..', 'dist');
const embedDir = path.join(distDir, 'embed');

mkdirSync(embedDir, { recursive: true });
copyFileSync(path.join(distDir, 'index.html'), path.join(embedDir, 'index.html'));
