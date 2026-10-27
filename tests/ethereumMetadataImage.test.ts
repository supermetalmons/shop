import assert from 'node:assert/strict';
import test from 'node:test';
import { isEthereumMetadataImage } from '../shared/ethereum/metadataImage.ts';

test('Ethereum metadata supports HTTPS images from any host and existing SVG data URIs', () => {
  for (const image of [
    'https://wip.lil.org/artwork.webp', 'https://future-cdn.example/artwork.png?revision=2#preview',
    'HTTPS://OTHER.EXAMPLE:8443/artwork%20one.svg', 'https://localhost/artwork.webp',
    'data:image/svg+xml;base64,PHN2Zy8+', 'data:image/svg+xml,%3Csvg%2F%3E',
  ]) assert.equal(isEthereumMetadataImage(image), true, image);
});

test('Ethereum metadata rejects credentials, unsafe schemes and malformed image URLs', () => {
  for (const image of [
    undefined, null, 1, {}, '', '/artwork.webp', '//wip.lil.org/artwork.webp',
    'http://wip.lil.org/artwork.webp', 'javascript:alert(1)', 'data:text/html,<svg/>',
    'blob:https://wip.lil.org/artwork.webp', 'ftp://wip.lil.org/artwork.webp',
    'https://user@wip.lil.org/artwork.webp', 'https://:password@wip.lil.org/artwork.webp',
    'https://user:password@wip.lil.org/artwork.webp', 'https://%75ser@wip.lil.org/artwork.webp',
    'https:', 'https://', 'https:wip.lil.org/artwork.webp', 'https://[invalid/artwork.webp',
    ' https://wip.lil.org/artwork.webp', 'https://wip.lil.org/artwork.webp\n',
    'https://wip.lil.org/\tartwork.webp', 'https://wip.lil.org\\artwork.webp',
  ]) assert.equal(isEthereumMetadataImage(image), false, String(image));
});
